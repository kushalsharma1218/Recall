package com.recall.backend.service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalDouble;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.PatchRecord;
import com.recall.backend.model.QueryTicket;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.model.Recommendation;
import com.recall.backend.model.SimilarIncident;
import com.recall.backend.model.TicketRecord;
import org.springframework.stereotype.Component;

@Component
public class LocalFallbackRecommender {

    private static final Pattern ERROR_CODE_RE = Pattern.compile("\\b(?:error|msg|code)\\s*[:#]?\\s*(\\d{3,6})\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SQL_STATE_RE = Pattern.compile("\\b(\\d{5})\\b");
    private static final Pattern PATCH_ID_RE = Pattern.compile("\\bP\\d{3,6}\\b", Pattern.CASE_INSENSITIVE);

    private static final Map<String, Pattern> EXCEPTION_PATTERNS = Map.ofEntries(
        Map.entry("deadlock", Pattern.compile("\\bdeadlock\\b|\\b1205\\b", Pattern.CASE_INSENSITIVE)),
        Map.entry("timeout", Pattern.compile("\\btimeout|timed\\s*out|query\\s+.*slow\\b", Pattern.CASE_INSENSITIVE)),
        Map.entry("oom", Pattern.compile("\\bout\\s*of\\s*memory|\\boom\\b|memory\\s*pressure\\b", Pattern.CASE_INSENSITIVE)),
        Map.entry("corruption", Pattern.compile("\\bcorrupt|suspect\\.database|\\b823\\b|\\b824\\b", Pattern.CASE_INSENSITIVE)),
        Map.entry("login", Pattern.compile("\\blogin\\s*fail|cannot\\s*connect|\\b18456\\b", Pattern.CASE_INSENSITIVE)),
        Map.entry("replication", Pattern.compile("\\breplica|sync\\s*fail|redo\\s*queue\\b", Pattern.CASE_INSENSITIVE)),
        Map.entry("throttle", Pattern.compile("\\b429\\b|too\\s+many\\s+requests|throttl", Pattern.CASE_INSENSITIVE))
    );

    private static final Set<String> STOPWORDS = Set.of(
        "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
        "is", "was", "are", "were", "be", "been", "being", "have", "has", "had", "do", "does",
        "did", "will", "would", "could", "should", "may", "might", "shall", "can", "need", "not",
        "no", "yes", "also", "as", "if", "when", "while", "then", "than", "so", "too", "very",
        "just", "more", "most", "all", "some", "any", "each", "our", "your", "their", "my",
        "error", "errors", "issue", "issues", "problem", "problems", "ticket", "azure", "database", "db", "sql"
    );

    /** BM25 saturation parameters, shared by scoring and the absolute-scale upper bound. */
    private static final double BM25_K1 = 1.5;
    private static final double BM25_B = 0.75;

    /**
     * Abstain gates. These are only meaningful because the retrieval score is on an absolute
     * scale (see {@link #bm25UpperBound}) rather than normalised against the best row in the batch.
     */
    private static final int MIN_TOP_CONFIDENCE = 46;
    private static final double MIN_TOP_SCORE = 0.18;
    private static final double MIN_TOP_MARGIN = 0.08;
    private static final int MARGIN_EXEMPT_CONFIDENCE = 67;
    /**
     * Below this margin the top two candidates are an effective tie. High confidence is confidence
     * that the *incident* matches, which says nothing about which of two different fixes to apply,
     * so a tie this tight always goes back to a human regardless of confidence.
     */
    private static final double TIE_MARGIN = 0.02;

    /** Recency is a nudge, not a verdict: a stale ticket must never be buried by age alone. */
    private static final double RECENCY_MIN = 0.92;
    private static final double RECENCY_MAX = 1.08;

    /** Bound on distinct patch ids tracked in memory, so unbounded feedback cannot exhaust the heap. */
    private static final int MAX_TRACKED_FEEDBACK_KEYS = 10_000;
    private static final int MAX_PATCH_ID_LENGTH = 200;

    private final ConcurrentHashMap<String, VoteCounter> feedback = new ConcurrentHashMap<>();

    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engine", "spring-local-hybrid");
        // The corpus is supplied per request, so this process holds no tickets of its own.
        // Reporting a hardcoded 0 read as "the corpus failed to load"; say what is actually true.
        out.put("corpus_source", "request");
        out.put("ollama_reachable", false);
        out.put("feedback_tracked", feedback.size());
        return out;
    }

    public Map<String, Object> reload() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("reloaded_at", Instant.now().toString());
        out.put("feedback_tracked", feedback.size());
        return out;
    }

    public RecommendResponse recommend(RecommendRequest request) {
        RecommendResponse response = new RecommendResponse();
        response.engine = "spring-local-hybrid";

        List<IncidentDoc> docs = buildDocs(request.localCorpus);
        if (docs.isEmpty()) {
            response.abstained = true;
            response.abstainCode = "empty_corpus";
            response.abstainReason = "No resolved ticket corpus is available yet.";
            response.needsResolutionInput = true;
            response.debug.put("reason", "empty_corpus");
            return response;
        }

        QueryTicket query = request.query == null ? new QueryTicket() : request.query;
        String queryText = String.join(" ", safe(query.title), safe(query.description), joinTags(query.tags));
        List<String> queryTokens = weightedTokens(query.title, query.description, parseTags(query.tags), "", "");
        if (queryTokens.isEmpty()) {
            response.abstained = true;
            response.abstainCode = "empty_query";
            response.abstainReason = "Query is too short. Provide title and symptoms.";
            // A thin query is a malformed request, not a gap in the corpus: asking the
            // engineer to contribute a fix here would be asking the wrong question.
            response.needsResolutionInput = false;
            response.debug.put("reason", "empty_query");
            return response;
        }

        Map<String, PatchRecord> patchMap = (request.patches == null ? List.<PatchRecord>of() : request.patches)
            .stream()
            .filter(p -> p != null && p.id != null && !p.id.isBlank())
            .collect(Collectors.toMap(p -> p.id, p -> p, (a, b) -> a, LinkedHashMap::new));

        Map<String, Integer> docFreq = buildDocFreq(docs);
        Map<String, Double> idf = buildIdf(docFreq, docs.size());
        double avgDocLen = docs.stream().mapToInt(d -> d.docLen).average().orElse(1.0);

        for (IncidentDoc doc : docs) {
            doc.vec = tfidfVec(doc.tokens, idf);
        }

        Map<String, Object> queryPayload = new LinkedHashMap<>();
        queryPayload.put("title", safe(query.title));
        queryPayload.put("description", safe(query.description));
        queryPayload.put("severity", safe(query.severity));
        queryPayload.put("system", safe(query.system));
        queryPayload.put("tags", parseTags(query.tags));
        Signals querySignals = extractSignals(queryPayload);

        Map<String, Double> queryVec = tfidfVec(queryTokens, idf);
        Set<String> querySet = new HashSet<>(queryTokens);

        Map<String, Double> bm25Values = new LinkedHashMap<>();
        Map<String, Double> cosineValues = new LinkedHashMap<>();
        Map<String, Double> overlapValues = new LinkedHashMap<>();
        Map<String, Double> signalValues = new LinkedHashMap<>();
        Map<String, Map<String, Double>> rawScores = new LinkedHashMap<>();

        for (IncidentDoc doc : docs) {
            double bm25 = bm25(queryTokens, doc.tf, doc.docLen, docFreq, docs.size(), avgDocLen);
            double cosine = cosine(queryVec, doc.vec);
            double overlap = lexicalOverlap(querySet, doc.tokenSet);
            double signal = overlapScore(querySignals, doc.signals);

            bm25Values.put(doc.ticketId, bm25);
            cosineValues.put(doc.ticketId, cosine);
            overlapValues.put(doc.ticketId, overlap);
            signalValues.put(doc.ticketId, signal);

            Map<String, Double> feature = new LinkedHashMap<>();
            feature.put("bm25", bm25);
            feature.put("cosine", cosine);
            feature.put("overlap", overlap);
            feature.put("signals", signal);
            rawScores.put(doc.ticketId, feature);
        }

        // Normalising by the best row in the batch made the top row score 1.0 no matter how
        // poor the match was, which defeated every absolute abstain threshold below. Scale by
        // the score the query could achieve against a perfectly matching document instead.
        double bm25Ceiling = bm25UpperBound(queryTokens, docFreq, docs.size());
        Map<String, Double> bm25Norm = scaleByCeiling(bm25Values, bm25Ceiling);

        Map<String, Double> lexicalScore = new LinkedHashMap<>();
        for (IncidentDoc doc : docs) {
            String tid = doc.ticketId;
            double score =
                bm25Norm.getOrDefault(tid, 0.0) * 0.52
                    + cosineValues.getOrDefault(tid, 0.0) * 0.30
                    + overlapValues.getOrDefault(tid, 0.0) * 0.18;
            score *= 1.0 + Math.min(0.26, signalValues.getOrDefault(tid, 0.0) * 0.25);

            String qSystem = normalizeSystem(query.system);
            String dSystem = normalizeSystem(doc.system);
            if (!qSystem.isBlank() && !dSystem.isBlank()) {
                if (qSystem.equals(dSystem)) score *= 1.17;
                else if (qSystem.contains("sql") && dSystem.contains("sql")) score *= 1.04;
                else score *= 0.95;
            }

            String qSev = severityOrBlank(query.severity);
            String dSev = severityOrBlank(doc.severity);
            if (!qSev.isBlank() && !dSev.isBlank()) {
                score *= qSev.equals(dSev) ? 1.10 : 0.94;
            }

            double recency = recencyMultiplier(doc.changedDate);
            score *= recency;

            lexicalScore.put(tid, clamp(score, 0.0, 1.5));
            rawScores.get(tid).put("bm25", bm25Norm.getOrDefault(tid, 0.0));
            rawScores.get(tid).put("recency", recency);
        }

        // Reciprocal-rank fusion only adds information when it fuses *independent* rankings.
        // Fusing the single lexical list with itself just re-expressed the same order while
        // handing rank credit to documents that matched nothing at all.
        Map<String, Double> rrfScores = rrf(
            List.of(
                rankedIds(lexicalScore),
                rankedIds(bm25Values),
                rankedIds(cosineValues),
                rankedIds(signalValues)
            ),
            60
        );
        Map<String, Double> rrfNorm = normalize01(rrfScores);

        List<ScoredDoc> combined = new ArrayList<>();
        for (IncidentDoc doc : docs) {
            String tid = doc.ticketId;
            double score = lexicalScore.getOrDefault(tid, 0.0) * 0.86
                + signalValues.getOrDefault(tid, 0.0) * 0.14
                + rrfNorm.getOrDefault(tid, 0.0) * 0.08;

            combined.add(new ScoredDoc(doc, score));
            rawScores.get(tid).put("rrf", rrfNorm.getOrDefault(tid, 0.0));
            rawScores.get(tid).put("combined", score);
        }

        combined.sort(Comparator.comparingDouble((ScoredDoc s) -> s.score).reversed());
        double topSimilarity = combined.isEmpty() ? 0.0 : combined.get(0).score;
        double similarityFloor = Math.max(0.04, topSimilarity * 0.23);
        List<ScoredDoc> topMatches = combined.stream().limit(40).filter(s -> s.score >= similarityFloor).toList();

        response.similarIncidents = topMatches.stream().limit(5).map(s -> {
            SimilarIncident si = new SimilarIncident();
            si.ticketId = s.doc.ticketId;
            si.title = s.doc.title;
            si.similarity = round(s.score, 4);
            si.resolvedPatch = s.doc.resolvedPatch == null || s.doc.resolvedPatch.isBlank() ? null : s.doc.resolvedPatch;
            si.resolutionDescription = safe(s.doc.resolution);
            si.severity = safe(s.doc.severity);
            si.system = safe(s.doc.system);
            si.source = safe(s.doc.source);
            return si;
        }).toList();

        Map<String, PatchBucket> grouped = new LinkedHashMap<>();
        for (ScoredDoc s : topMatches) {
            IncidentDoc doc = s.doc;
            String patchId = safe(doc.resolvedPatch);
            if (patchId.isBlank()) continue;
            if (!patchMap.isEmpty() && !patchMap.containsKey(patchId)) continue;

            PatchBucket bucket = grouped.computeIfAbsent(patchId, ignored -> new PatchBucket());
            bucket.scoreSum += s.score;
            bucket.bestScore = Math.max(bucket.bestScore, s.score);
            bucket.count += 1;
            bucket.docs.add(s);

            double sig = signalValues.getOrDefault(doc.ticketId, 0.0);
            bucket.signalSum += sig;

            String bucketQuerySeverity = severityOrBlank(query.severity);
            if (!bucketQuerySeverity.isBlank() && bucketQuerySeverity.equals(severityOrBlank(doc.severity))) {
                bucket.severityHits += 1;
            }
            if (!normalizeSystem(query.system).isBlank() && normalizeSystem(doc.system).equals(normalizeSystem(query.system))) {
                bucket.systemHits += 1;
            }

            Set<String> qErrors = new HashSet<>(querySignals.errorCodes);
            Set<String> dErrors = new HashSet<>(doc.signals.errorCodes);
            qErrors.retainAll(dErrors);
            if (!qErrors.isEmpty()) bucket.errorHits += 1;

            for (String token : querySet) {
                if (doc.tokenSet.contains(token) && !token.startsWith("severity_") && !token.startsWith("system_")) {
                    bucket.topTerms.put(token, bucket.topTerms.getOrDefault(token, 0) + 1);
                }
            }
        }

        List<Recommendation> recommendations = new ArrayList<>();
        for (Map.Entry<String, PatchBucket> entry : grouped.entrySet()) {
            String patchId = entry.getKey();
            PatchBucket g = entry.getValue();

            double avgSimilarity = g.scoreSum / Math.max(1, g.count);
            double bestSimilarity = g.bestScore;
            // Confidence used to be driven by the bucket mean alone, so a weak-but-above-floor
            // third ticket supporting the same fix *lowered* confidence in a strong top match and
            // could tip a correct answer into an abstain. Corroboration must never subtract.
            // Lean on the best evidence; keep the mean as a consistency term.
            double representativeSimilarity = 0.7 * bestSimilarity + 0.3 * avgSimilarity;
            int support = g.count;
            double signalStrength = g.signalSum / Math.max(1, support);
            double sevRatio = (double) g.severityHits / Math.max(1, support);
            double sysRatio = (double) g.systemHits / Math.max(1, support);
            double errRatio = (double) g.errorHits / Math.max(1, support);

            double supportBoost = 1.0 + Math.min(0.24, (Math.log(support + 1) / Math.log(2.0)) * 0.09);
            double signalBoost = 1.0 + Math.min(0.22, signalStrength * 0.4);
            double severityBoost = 1.0 + sevRatio * 0.12;
            double systemBoost = 1.0 + sysRatio * 0.2;
            double errorBoost = 1.0 + errRatio * 0.25;

            FeedbackScore feedbackScore = feedbackMultiplier(patchId);

            double finalScore = representativeSimilarity * supportBoost * signalBoost * severityBoost * systemBoost * errorBoost * feedbackScore.multiplier;

            double confidenceBase =
                representativeSimilarity * 70.0
                    + Math.min(16.0, support * 3.8)
                    + signalStrength * 16.0
                    + sysRatio * 12.0
                    + errRatio * 12.0
                    + feedbackScore.delta * 20.0;
            int confidence = (int) Math.round(clamp(confidenceBase, 8.0, 98.0));

            List<String> topTerms = g.topTerms.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(3)
                .map(Map.Entry::getKey)
                .toList();

            List<String> reasonParts = new ArrayList<>();
            reasonParts.add(support + " similar resolved incident" + (support == 1 ? "" : "s"));
            if (!querySignals.errorCodes.isEmpty() && g.errorHits > 0) reasonParts.add("error-code overlap");
            if (sysRatio > 0) reasonParts.add("system match " + g.systemHits + "/" + support);
            if (sevRatio > 0) reasonParts.add("severity match " + g.severityHits + "/" + support);
            if (!topTerms.isEmpty()) reasonParts.add("signals: " + String.join(", ", topTerms));

            Recommendation recommendation = new Recommendation();
            recommendation.patchId = patchId;
            recommendation.confidence = confidence;
            recommendation.score = round(finalScore, 6);
            recommendation.reasoning = "Matched " + String.join(" · ", reasonParts) + ".";
            recommendation.evidence = g.docs.stream()
                .sorted(Comparator.comparingDouble((ScoredDoc d) -> d.score).reversed())
                .limit(4)
                .map(d -> d.doc.ticketId)
                .toList();

            if (Boolean.TRUE.equals(request.debug)) {
                recommendation.features.put("avg_similarity", round(avgSimilarity, 6));
                recommendation.features.put("best_similarity", round(bestSimilarity, 6));
                recommendation.features.put("representative_similarity", round(representativeSimilarity, 6));
                recommendation.features.put("support", (double) support);
                recommendation.features.put("signal_strength", round(signalStrength, 6));
                recommendation.features.put("severity_ratio", round(sevRatio, 6));
                recommendation.features.put("system_ratio", round(sysRatio, 6));
                recommendation.features.put("error_ratio", round(errRatio, 6));
                recommendation.features.put("feedback_multiplier", round(feedbackScore.multiplier, 6));
            }
            recommendations.add(recommendation);
        }

        recommendations.sort(Comparator.comparingDouble((Recommendation r) -> r.score).reversed());
        int topK = clampTopK(request.topK);
        if (recommendations.size() > topK) {
            recommendations = recommendations.subList(0, topK);
        }

        boolean abstained = false;
        String abstainCode = null;
        String abstainReason = null;
        double topMargin = 1.0;
        if (recommendations.isEmpty()) {
            abstained = true;
            if (topMatches.isEmpty()) {
                abstainCode = "no_similar_incident";
                abstainReason = "No past incident resembles this one closely enough to learn from.";
            } else {
                abstainCode = "no_patch_evidence";
                abstainReason = "Similar incidents were found, but none records a fix we can reuse.";
            }
        } else {
            Recommendation top = recommendations.get(0);
            Recommendation second = recommendations.size() > 1 ? recommendations.get(1) : null;
            if (second != null) {
                topMargin = (top.score - second.score) / Math.max(top.score, 1e-6);
            }

            // Every bucket is built from at least one document, so top.evidence is never empty
            // here; the old check for it could not fire and is dropped.
            if (top.confidence < MIN_TOP_CONFIDENCE || top.score < MIN_TOP_SCORE) {
                abstained = true;
                abstainCode = "weak_evidence";
                abstainReason = "Similar incidents found, but none matches closely enough to propose a fix.";
            } else if (second != null
                && (topMargin < TIE_MARGIN
                    || (topMargin < MIN_TOP_MARGIN && top.confidence < MARGIN_EXEMPT_CONFIDENCE))) {
                abstained = true;
                abstainCode = "ambiguous_evidence";
                abstainReason = "Several past fixes match about equally well; no single fix stands out.";
            }

            if (abstained) {
                recommendations = List.of();
            }
        }

        response.abstained = abstained;
        response.abstainCode = abstainCode;
        response.abstainReason = abstainReason;
        // Signals to the caller that the right next step is to collect a resolution from the
        // engineer and feed it back into the corpus, rather than to show a guessed fix.
        response.needsResolutionInput = abstained;
        response.recommendations = recommendations;

        if (Boolean.TRUE.equals(request.debug)) {
            response.debug.put("corpus_size", docs.size());
            response.debug.put("top_similarity", round(topSimilarity, 6));
            response.debug.put("similarity_floor", round(similarityFloor, 6));
            response.debug.put("bm25_ceiling", round(bm25Ceiling, 6));
            response.debug.put("top_margin", round(topMargin, 6));
            response.debug.put("top_candidates", combined.stream().limit(8).map(sc -> {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("ticket_id", sc.doc.ticketId);
                item.put("score", round(sc.score, 6));
                item.put("features", rawScores.getOrDefault(sc.doc.ticketId, Map.of()));
                item.put("resolved_patch", safe(sc.doc.resolvedPatch));
                return item;
            }).toList());
        }

        return response;
    }

    public FeedbackResponse recordFeedback(String patchId, String vote) {
        String key = safe(patchId).trim();
        if (key.isBlank()) {
            throw new IllegalArgumentException("patchId is required");
        }
        if (key.length() > MAX_PATCH_ID_LENGTH) {
            throw new IllegalArgumentException("patchId must be at most " + MAX_PATCH_ID_LENGTH + " characters");
        }
        String normalizedVote = safe(vote).trim().toLowerCase(Locale.ROOT);
        if (!"up".equals(normalizedVote) && !"down".equals(normalizedVote)) {
            throw new IllegalArgumentException("vote must be 'up' or 'down'");
        }

        // Patch ids arrive from the client, so an unbounded map is a memory-exhaustion vector.
        // Existing keys keep accepting votes; only brand-new keys are refused once the cap is hit.
        if (!feedback.containsKey(key) && feedback.size() >= MAX_TRACKED_FEEDBACK_KEYS) {
            throw new IllegalStateException("Feedback capacity reached; reload the backend to reset counters");
        }

        VoteCounter counter = feedback.computeIfAbsent(key, ignored -> new VoteCounter());
        if ("up".equals(normalizedVote)) {
            counter.positive.incrementAndGet();
        } else {
            counter.negative.incrementAndGet();
        }

        return new FeedbackResponse(key, counter.positive.get(), counter.negative.get());
    }

    private List<IncidentDoc> buildDocs(List<TicketRecord> localCorpus) {
        if (localCorpus == null || localCorpus.isEmpty()) {
            return List.of();
        }

        List<IncidentDoc> docs = new ArrayList<>();
        for (TicketRecord ticket : localCorpus) {
            if (ticket == null) continue;

            String id = safeTicketId(ticket);
            String title = safe(ticket.title);
            String description = safe(ticket.description);
            String resolution = safe(ticket.resolutionDescription);
            String severity = severityOrBlank(ticket.severity);
            String system = safe(ticket.system);
            String source = safe(ticket.source);
            String changedDate = safe(ticket.changedDate);
            String resolvedPatch = safe(ticket.resolvedPatch);
            List<String> tags = parseTags(ticket.tags);

            String textBlob = String.join(" ", title, description, resolution, String.join(" ", tags), system).trim();

            Map<String, Object> signalSource = new LinkedHashMap<>();
            signalSource.put("title", title);
            signalSource.put("description", description);
            signalSource.put("resolutionDescription", resolution);
            signalSource.put("tags", tags);
            signalSource.put("system", system);
            signalSource.put("severity", severity);
            signalSource.put("resolvedPatch", resolvedPatch);
            Signals signals = extractSignals(signalSource);

            List<String> tokens = weightedTokens(title, description, tags, resolution, "");
            if (tokens.isEmpty()) continue;

            IncidentDoc doc = new IncidentDoc();
            doc.ticketId = id;
            doc.title = title;
            doc.description = description;
            doc.resolution = resolution;
            doc.severity = severity;
            doc.system = system;
            doc.tags = tags;
            doc.resolvedPatch = resolvedPatch;
            doc.source = source;
            doc.changedDate = changedDate;
            doc.textBlob = textBlob;
            doc.signals = signals;
            doc.tokens = tokens;
            doc.tokenSet = new HashSet<>(tokens);
            doc.tf = termFrequency(tokens);
            doc.docLen = Math.max(1, tokens.size());
            docs.add(doc);
        }
        return docs;
    }

    private Map<String, Integer> buildDocFreq(List<IncidentDoc> docs) {
        Map<String, Integer> df = new HashMap<>();
        for (IncidentDoc doc : docs) {
            for (String token : doc.tokenSet) {
                df.put(token, df.getOrDefault(token, 0) + 1);
            }
        }
        return df;
    }

    private Map<String, Double> buildIdf(Map<String, Integer> df, int totalDocs) {
        Map<String, Double> idf = new HashMap<>();
        for (Map.Entry<String, Integer> entry : df.entrySet()) {
            idf.put(entry.getKey(), Math.log((totalDocs + 1.0) / (entry.getValue() + 1.0)) + 1.0);
        }
        return idf;
    }

    private Map<String, Integer> termFrequency(List<String> tokens) {
        Map<String, Integer> tf = new HashMap<>();
        for (String token : tokens) {
            tf.put(token, tf.getOrDefault(token, 0) + 1);
        }
        return tf;
    }

    private Map<String, Double> tfidfVec(List<String> tokens, Map<String, Double> idf) {
        if (tokens.isEmpty()) return Map.of();
        Map<String, Integer> tf = termFrequency(tokens);
        int len = tokens.size();
        Map<String, Double> vec = new HashMap<>();
        for (Map.Entry<String, Integer> entry : tf.entrySet()) {
            vec.put(entry.getKey(), (entry.getValue() / (double) len) * idf.getOrDefault(entry.getKey(), 1.0));
        }
        return vec;
    }

    private double bm25(List<String> queryTokens, Map<String, Integer> docTf, int docLen, Map<String, Integer> docFreq, int totalDocs, double avgDocLen) {
        if (queryTokens.isEmpty() || docLen <= 0 || totalDocs <= 0) return 0.0;

        double score = 0.0;
        Set<String> uniqueQuery = new HashSet<>(queryTokens);

        for (String term : uniqueQuery) {
            int tf = docTf.getOrDefault(term, 0);
            if (tf == 0) continue;
            double idf = bm25Idf(term, docFreq, totalDocs);
            double denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / Math.max(avgDocLen, 1e-6)));
            score += idf * ((tf * (BM25_K1 + 1.0)) / denom);
        }
        return score;
    }

    private double bm25Idf(String term, Map<String, Integer> docFreq, int totalDocs) {
        int df = docFreq.getOrDefault(term, 0);
        return Math.log(1.0 + ((totalDocs - df + 0.5) / (df + 0.5)));
    }

    /**
     * Highest BM25 score this query could earn against a hypothetical document that saturates
     * every query term. Dividing by it turns BM25 into an absolute "how much of the query did
     * this document actually cover" ratio, so the abstain thresholds mean something.
     *
     * <p>Query terms absent from the whole corpus are deliberately still counted, because a
     * document that does not contain them has genuinely not matched the full query.
     */
    private double bm25UpperBound(List<String> queryTokens, Map<String, Integer> docFreq, int totalDocs) {
        double ceiling = 0.0;
        for (String term : new HashSet<>(queryTokens)) {
            // tf -> infinity drives the saturation term to its (k1 + 1) limit.
            ceiling += bm25Idf(term, docFreq, totalDocs) * (BM25_K1 + 1.0);
        }
        return ceiling;
    }

    private Map<String, Double> scaleByCeiling(Map<String, Double> values, double ceiling) {
        if (values.isEmpty()) return Map.of();
        Map<String, Double> out = new LinkedHashMap<>();
        if (ceiling <= 0.0) {
            values.keySet().forEach(k -> out.put(k, 0.0));
            return out;
        }
        values.forEach((k, v) -> out.put(k, clamp(v / ceiling, 0.0, 1.0)));
        return out;
    }

    /** Ids ordered by descending value, keeping only entries that actually scored. */
    private List<String> rankedIds(Map<String, Double> values) {
        return values.entrySet().stream()
            .filter(e -> e.getValue() != null && e.getValue() > 0.0)
            .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
            .limit(200)
            .map(Map.Entry::getKey)
            .toList();
    }

    private double cosine(Map<String, Double> a, Map<String, Double> b) {
        if (a.isEmpty() || b.isEmpty()) return 0.0;

        Set<String> keys = new HashSet<>();
        keys.addAll(a.keySet());
        keys.addAll(b.keySet());

        double dot = 0.0;
        double ma = 0.0;
        double mb = 0.0;
        for (String key : keys) {
            double av = a.getOrDefault(key, 0.0);
            double bv = b.getOrDefault(key, 0.0);
            dot += av * bv;
            ma += av * av;
            mb += bv * bv;
        }
        double denom = Math.sqrt(ma) * Math.sqrt(mb);
        if (denom <= 0.0) return 0.0;
        return dot / denom;
    }

    private double lexicalOverlap(Set<String> a, Set<String> b) {
        if (a.isEmpty() || b.isEmpty()) return 0.0;
        int shared = 0;
        for (String token : a) {
            if (b.contains(token)) shared++;
        }
        if (shared == 0) return 0.0;
        return shared / Math.sqrt((double) a.size() * (double) b.size());
    }

    private Map<String, Double> normalize01(Map<String, Double> values) {
        if (values.isEmpty()) return Map.of();
        double max = values.values().stream().mapToDouble(Double::doubleValue).max().orElse(0.0);
        if (max <= 0.0) {
            Map<String, Double> zeros = new LinkedHashMap<>();
            values.keySet().forEach(k -> zeros.put(k, 0.0));
            return zeros;
        }
        Map<String, Double> out = new LinkedHashMap<>();
        values.forEach((k, v) -> out.put(k, v / max));
        return out;
    }

    private Map<String, Double> rrf(List<List<String>> rankedLists, int k) {
        Map<String, Double> scores = new HashMap<>();
        for (List<String> ranked : rankedLists) {
            int rank = 1;
            for (String item : ranked) {
                scores.put(item, scores.getOrDefault(item, 0.0) + 1.0 / (k + rank));
                rank++;
            }
        }
        return scores;
    }

    /**
     * Age of a ticket in days, or empty when no usable timestamp was supplied. An unknown date
     * is genuinely unknown; it must not be reported as "very old".
     */
    private OptionalDouble daysSince(String isoDate) {
        String value = safe(isoDate).trim();
        if (value.isEmpty()) return OptionalDouble.empty();

        Instant instant = parseInstant(value);
        if (instant == null) return OptionalDouble.empty();

        Duration delta = Duration.between(instant, Instant.now());
        return OptionalDouble.of(Math.max(0.0, delta.toSeconds() / 86400.0));
    }

    private Instant parseInstant(String value) {
        String normalized = value.replace(" ", "T");
        try {
            return OffsetDateTime.parse(normalized.replace("Z", "+00:00")).toInstant();
        } catch (DateTimeParseException ignored) {
            // fall through
        }
        try {
            return Instant.parse(normalized);
        } catch (DateTimeParseException ignored) {
            // fall through
        }
        try {
            // Azure DevOps sends offset timestamps, but CSV and manual imports routinely carry
            // a local date-time or a bare date. Treat those as UTC rather than discarding them.
            return LocalDateTime.parse(normalized).toInstant(ZoneOffset.UTC);
        } catch (DateTimeParseException ignored) {
            // fall through
        }
        try {
            return LocalDate.parse(normalized).atStartOfDay().toInstant(ZoneOffset.UTC);
        } catch (DateTimeParseException ignored) {
            return null;
        }
    }

    /**
     * Recency is a tie-breaker between otherwise comparable incidents, so it is clamped to a
     * narrow band. The previous formula was unbounded below and multiplied an unknown or
     * unparseable date by ~0.55, burying otherwise perfect matches for having no timestamp.
     */
    private double recencyMultiplier(String changedDate) {
        OptionalDouble days = daysSince(changedDate);
        if (days.isEmpty()) return 1.0;

        double raw = 1.0 + (180.0 / Math.max(180.0, days.getAsDouble() + 30.0) - 0.5);
        return clamp(raw, RECENCY_MIN, RECENCY_MAX);
    }

    private FeedbackScore feedbackMultiplier(String patchId) {
        VoteCounter counter = feedback.get(patchId);
        double positive = counter == null ? 0.0 : counter.positive.get();
        double negative = counter == null ? 0.0 : counter.negative.get();
        double votes = positive + negative;
        if (votes == 0.0) {
            return new FeedbackScore(1.0, 0.0);
        }
        double bayes = (positive + 2.0) / (votes + 4.0);
        double reliability = Math.min(1.0, votes / 8.0);
        double delta = (bayes - 0.5) * reliability;
        double multiplier = clamp(1.0 + delta * 0.9, 0.2, 2.8);
        return new FeedbackScore(multiplier, delta);
    }

    private Signals extractSignals(Map<String, Object> source) {
        String title = safe(stringVal(source.get("title")));
        String description = safe(stringVal(source.get("description")));
        String resolution = safe(stringVal(source.get("resolutionDescription")));
        String comments = safe(stringVal(source.get("comments")));
        String tags = String.join(" ", parseTags(source.get("tags")));
        String system = safe(stringVal(source.get("system")));
        String severity = severityOrBlank(stringVal(source.get("severity")));

        String combined = String.join(" ", title, description, resolution, comments, tags, system).trim();

        Set<String> errorCodes = new LinkedHashSet<>();
        Matcher em = ERROR_CODE_RE.matcher(combined);
        while (em.find()) {
            errorCodes.add(em.group(1));
        }

        Set<String> sqlStates = new LinkedHashSet<>();
        Matcher sm = SQL_STATE_RE.matcher(combined);
        while (sm.find()) {
            sqlStates.add(sm.group(1));
        }

        String exceptionType = detectException(combined);
        String dbEngine = normalizeSystem(!system.isBlank() ? system : combined);

        String resolvedPatch = null;
        Matcher pm = PATCH_ID_RE.matcher(String.join(" ", resolution, comments, tags));
        if (pm.find()) {
            resolvedPatch = pm.group().toUpperCase(Locale.ROOT);
        } else {
            String direct = stringVal(source.get("resolvedPatch"));
            if (!direct.isBlank()) resolvedPatch = direct;
        }

        Signals signals = new Signals();
        signals.errorCodes = new ArrayList<>(errorCodes);
        signals.sqlStates = new ArrayList<>(sqlStates);
        signals.dbEngine = dbEngine;
        signals.exceptionType = exceptionType;
        signals.severity = severity;
        signals.resolvedPatch = resolvedPatch;
        signals.combinedText = combined;
        return signals;
    }

    private String detectException(String text) {
        for (Map.Entry<String, Pattern> entry : EXCEPTION_PATTERNS.entrySet()) {
            if (entry.getValue().matcher(text).find()) {
                return entry.getKey();
            }
        }
        return "unknown";
    }

    private double overlapScore(Signals query, Signals candidate) {
        double score = 0.0;

        Set<String> qErrors = new HashSet<>(query.errorCodes);
        Set<String> cErrors = new HashSet<>(candidate.errorCodes);
        if (!qErrors.isEmpty() && !cErrors.isEmpty()) {
            Set<String> inter = new HashSet<>(qErrors);
            inter.retainAll(cErrors);
            if (!inter.isEmpty()) {
                score += Math.min(1.0, inter.size() / (double) Math.max(1, qErrors.size())) * 0.5;
            }
        }

        if (!query.dbEngine.isBlank() && !candidate.dbEngine.isBlank() && query.dbEngine.equals(candidate.dbEngine)) {
            score += 0.25;
        }

        if (!"unknown".equals(query.exceptionType) && query.exceptionType.equals(candidate.exceptionType)) {
            score += 0.2;
        }

        if (!query.severity.isBlank() && query.severity.equals(candidate.severity)) {
            score += 0.05;
        }

        return Math.min(1.0, score);
    }

    private List<String> weightedTokens(String title, String description, List<String> tags, String resolution, String codeText) {
        List<String> out = new ArrayList<>();
        out.addAll(repeat(tokenize(title), 3));
        out.addAll(repeat(tokenize(description), 2));
        if (tags != null && !tags.isEmpty()) {
            List<String> normTags = tags.stream().map(this::normalizeToken).filter(t -> !t.isBlank()).toList();
            out.addAll(repeat(normTags, 3));
        }
        out.addAll(repeat(tokenize(resolution), 2));
        out.addAll(repeat(tokenize(codeText), 2));
        return out;
    }

    private List<String> repeat(List<String> tokens, int n) {
        if (tokens == null || tokens.isEmpty() || n <= 0) return List.of();
        List<String> out = new ArrayList<>(tokens.size() * n);
        for (int i = 0; i < n; i++) {
            out.addAll(tokens);
        }
        return out;
    }

    private List<String> tokenize(String text) {
        String normalized = normalizeText(text);
        normalized = normalized.replaceAll("[^a-z0-9_\\s'\\-]", " ");
        if (normalized.isBlank()) return List.of();

        String[] split = normalized.trim().split("\\s+");
        List<String> out = new ArrayList<>();
        for (String token : split) {
            String nt = normalizeToken(token);
            if (nt.isBlank() || nt.length() <= 2 || STOPWORDS.contains(nt)) continue;
            out.add(nt);
        }
        return out;
    }

    private List<String> parseTags(Object raw) {
        if (raw == null) return List.of();

        List<String> source = new ArrayList<>();
        if (raw instanceof Collection<?> c) {
            for (Object v : c) source.add(String.valueOf(v));
        } else {
            source.addAll(Arrays.asList(String.valueOf(raw).split("[;,|]")));
        }

        Set<String> dedup = new LinkedHashSet<>();
        for (String token : source) {
            String norm = normalizeToken(token.trim().toLowerCase(Locale.ROOT));
            if (!norm.isBlank()) dedup.add(norm);
        }
        return new ArrayList<>(dedup);
    }

    private String normalizeText(String value) {
        String out = safe(value).toLowerCase(Locale.ROOT);
        out = out.replaceAll("\\bdead[\\s-]?locks?\\b", " deadlock ");
        out = out.replaceAll("\\btime[\\s-]?outs?\\b", " timeout ");
        out = out.replaceAll("\\bout[\\s-]?of[\\s-]?memory\\b", " oom ");
        out = out.replaceAll("\\btoo many requests\\b", " 429 ");
        out = out.replaceAll("\\bavailability[\\s-]?groups?\\b", " alwayson ");
        out = out.replaceAll("\\balways[\\s-]?on\\b", " alwayson ");
        out = out.replaceAll("\\bmanaged[\\s-]?instance\\b", " managedinstance ");
        out = out.replaceAll("\\belastic[\\s-]?pool\\b", " elasticpool ");
        return out;
    }

    private String normalizeToken(String token) {
        String t = safe(token).toLowerCase(Locale.ROOT).trim();
        if (t.isBlank()) return "";

        if (t.matches("\\d{3,6}")) {
            return "code_" + t;
        }

        t = switch (t) {
            case "deadlocks" -> "deadlock";
            case "timeouts", "timedout" -> "timeout";
            case "throttled", "throttling" -> "throttle";
            case "retries", "retried" -> "retry";
            case "blocking", "blocked" -> "block";
            case "contention", "contentions" -> "contend";
            case "memorypressure", "outofmemory" -> "oom";
            case "postgres", "pg" -> "postgresql";
            case "cosmosdb" -> "cosmos";
            default -> t;
        };

        if (t.endsWith("ies") && t.length() > 4) {
            t = t.substring(0, t.length() - 3) + "y";
        } else if (t.endsWith("ing") && t.length() > 5) {
            t = t.substring(0, t.length() - 3);
        } else if (t.endsWith("ed") && t.length() > 4) {
            t = t.substring(0, t.length() - 2);
        } else if (t.endsWith("s") && t.length() > 3 && !t.endsWith("ss")) {
            t = t.substring(0, t.length() - 1);
        }

        t = switch (t) {
            case "postgres", "pg" -> "postgresql";
            case "cosmosdb" -> "cosmos";
            default -> t;
        };

        return t;
    }

    private String normalizeSeverity(String raw) {
        String s = severityOrBlank(raw);
        return s.isBlank() ? "medium" : s;
    }

    /**
     * Severity for scoring purposes, preserving "not supplied" as blank.
     *
     * <p>Collapsing an absent severity to "medium" made every request carry a severity nobody
     * entered, so unrelated tickets earned a match bonus and correctly-matching tickets of a
     * different severity were penalised — on a field the user never filled in.
     */
    private String severityOrBlank(String raw) {
        String s = safe(raw).trim().toLowerCase(Locale.ROOT);
        return switch (s) {
            case "critical", "high", "medium", "low" -> s;
            default -> "";
        };
    }

    private String normalizeSystem(String raw) {
        String s = normalizeText(raw);
        if (s.isBlank()) return "";
        if (s.contains("cosmos")) return "cosmos";
        if (s.contains("postgres")) return "postgresql";
        if (s.contains("mysql")) return "mysql";
        if (s.contains("mariadb")) return "mariadb";
        if (s.contains("managedinstance")) return "sql-managed-instance";
        if (s.contains("serverless")) return "sql-serverless";
        if (s.contains("elasticpool")) return "sql-elastic-pool";
        if (s.contains("alwayson") || s.contains("availability group")) return "sql-alwayson";
        if (s.contains("azure sql")) return "azure-sql";
        if (s.contains("sql server")) return "sql-server";

        List<String> tokens = tokenize(s);
        if (tokens.isEmpty()) return "";
        return tokens.stream().limit(2).collect(Collectors.joining("-"));
    }

    private String safeTicketId(TicketRecord ticket) {
        if (ticket.id == null) return "unknown";
        return String.valueOf(ticket.id);
    }

    private String joinTags(Object raw) {
        return String.join(" ", parseTags(raw));
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }

    private String stringVal(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private int clampTopK(Integer value) {
        int k = value == null ? 5 : value;
        if (k < 1) return 1;
        return Math.min(k, 10);
    }

    private double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private double round(double value, int decimals) {
        double factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    private static final class IncidentDoc {
        private String ticketId;
        private String title;
        private String description;
        private String resolution;
        private String severity;
        private String system;
        private List<String> tags;
        private String resolvedPatch;
        private String source;
        private String changedDate;
        private String textBlob;
        private Signals signals;
        private List<String> tokens;
        private Set<String> tokenSet;
        private Map<String, Integer> tf;
        private int docLen;
        private Map<String, Double> vec = Map.of();
    }

    private static final class ScoredDoc {
        private final IncidentDoc doc;
        private final double score;

        private ScoredDoc(IncidentDoc doc, double score) {
            this.doc = doc;
            this.score = score;
        }
    }

    private static final class PatchBucket {
        private double scoreSum = 0.0;
        private double bestScore = 0.0;
        private int count = 0;
        private double signalSum = 0.0;
        private int severityHits = 0;
        private int systemHits = 0;
        private int errorHits = 0;
        private final List<ScoredDoc> docs = new ArrayList<>();
        private final Map<String, Integer> topTerms = new HashMap<>();
    }

    private static final class Signals {
        private List<String> errorCodes = List.of();
        private List<String> sqlStates = List.of();
        private String dbEngine = "";
        private String exceptionType = "unknown";
        private String severity = "medium";
        private String resolvedPatch;
        private String combinedText = "";
    }

    private static final class VoteCounter {
        private final AtomicInteger positive = new AtomicInteger(0);
        private final AtomicInteger negative = new AtomicInteger(0);
    }

    private record FeedbackScore(double multiplier, double delta) {
    }
}
