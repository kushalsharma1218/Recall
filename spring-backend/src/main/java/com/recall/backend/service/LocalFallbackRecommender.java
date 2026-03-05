package com.recall.backend.service;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
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

    private final ConcurrentHashMap<String, VoteCounter> feedback = new ConcurrentHashMap<>();

    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engine", "spring-local-hybrid");
        out.put("tickets_loaded", 0);
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
            response.abstainReason = "No resolved ticket corpus is available yet.";
            response.debug.put("reason", "empty_corpus");
            return response;
        }

        QueryTicket query = request.query == null ? new QueryTicket() : request.query;
        String queryText = String.join(" ", safe(query.title), safe(query.description), joinTags(query.tags));
        List<String> queryTokens = weightedTokens(query.title, query.description, parseTags(query.tags), "", "");
        if (queryTokens.isEmpty()) {
            response.abstained = true;
            response.abstainReason = "Query is too short. Provide title and symptoms.";
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

        Map<String, Double> bm25Norm = normalize01(bm25Values);

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

            String qSev = normalizeSeverity(query.severity);
            String dSev = normalizeSeverity(doc.severity);
            if (!qSev.isBlank() && !dSev.isBlank()) {
                score *= qSev.equals(dSev) ? 1.10 : 0.94;
            }

            double days = daysSince(doc.changedDate);
            double recency = 1.0 + Math.min(0.1, 180.0 / Math.max(180.0, days + 30.0) - 0.5);
            score *= recency;

            lexicalScore.put(tid, clamp(score, 0.0, 1.5));
            rawScores.get(tid).put("bm25", bm25Norm.getOrDefault(tid, 0.0));
            rawScores.get(tid).put("recency", recency);
        }

        List<Map.Entry<String, Double>> lexicalRanked = lexicalScore.entrySet().stream()
            .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
            .toList();
        List<String> lexicalRankIds = lexicalRanked.stream().limit(200).map(Map.Entry::getKey).toList();

        Map<String, Double> rrfScores = rrf(List.of(lexicalRankIds), 60);
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
            bucket.count += 1;
            bucket.docs.add(s);

            double sig = signalValues.getOrDefault(doc.ticketId, 0.0);
            bucket.signalSum += sig;

            if (normalizeSeverity(doc.severity).equals(normalizeSeverity(query.severity))) {
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

            double finalScore = avgSimilarity * supportBoost * signalBoost * severityBoost * systemBoost * errorBoost * feedbackScore.multiplier;

            double confidenceBase =
                avgSimilarity * 70.0
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
        String abstainReason = null;
        if (recommendations.isEmpty()) {
            abstained = true;
            abstainReason = "No clear fix pattern found from similar incidents.";
        } else {
            Recommendation top = recommendations.get(0);
            Recommendation second = recommendations.size() > 1 ? recommendations.get(1) : null;
            double margin = 1.0;
            if (second != null) {
                margin = (top.score - second.score) / Math.max(top.score, 1e-6);
            }

            boolean weakEvidence = top.confidence < 46 || top.score < 0.18 || top.evidence.isEmpty();
            boolean ambiguous = second != null && margin < 0.08 && top.confidence < 67;
            if (weakEvidence || ambiguous) {
                abstained = true;
                abstainReason = "Similar incidents found, but no single fix has strong enough evidence yet.";
                recommendations = List.of();
            }
        }

        response.abstained = abstained;
        response.abstainReason = abstainReason;
        response.recommendations = recommendations;

        if (Boolean.TRUE.equals(request.debug)) {
            response.debug.put("corpus_size", docs.size());
            response.debug.put("top_similarity", round(topSimilarity, 6));
            response.debug.put("similarity_floor", round(similarityFloor, 6));
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
        String normalizedVote = safe(vote).trim().toLowerCase(Locale.ROOT);
        if (!"up".equals(normalizedVote) && !"down".equals(normalizedVote)) {
            throw new IllegalArgumentException("vote must be 'up' or 'down'");
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
            String severity = normalizeSeverity(ticket.severity);
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
        double k1 = 1.5;
        double b = 0.75;
        Set<String> uniqueQuery = new HashSet<>(queryTokens);

        for (String term : uniqueQuery) {
            int tf = docTf.getOrDefault(term, 0);
            if (tf == 0) continue;
            int df = docFreq.getOrDefault(term, 0);
            double idf = Math.log(1.0 + ((totalDocs - df + 0.5) / (df + 0.5)));
            double denom = tf + k1 * (1 - b + b * (docLen / Math.max(avgDocLen, 1e-6)));
            score += idf * ((tf * (k1 + 1.0)) / denom);
        }
        return score;
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

    private double daysSince(String isoDate) {
        String value = safe(isoDate).trim();
        if (value.isEmpty()) return 3650.0;
        try {
            OffsetDateTime date = OffsetDateTime.parse(value.replace("Z", "+00:00"));
            Duration delta = Duration.between(date.toInstant(), Instant.now());
            return Math.max(0.0, delta.toSeconds() / 86400.0);
        } catch (Exception ex1) {
            try {
                Instant parsed = Instant.parse(value);
                Duration delta = Duration.between(parsed, Instant.now());
                return Math.max(0.0, delta.toSeconds() / 86400.0);
            } catch (Exception ex2) {
                return 3650.0;
            }
        }
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
        String severity = normalizeSeverity(stringVal(source.get("severity")));

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
        String s = safe(raw).toLowerCase(Locale.ROOT);
        return switch (s) {
            case "critical", "high", "medium", "low" -> s;
            default -> "medium";
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
