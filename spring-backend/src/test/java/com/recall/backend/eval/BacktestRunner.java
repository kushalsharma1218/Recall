package com.recall.backend.eval;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recall.backend.model.PatchRecord;
import com.recall.backend.model.QueryTicket;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.model.Recommendation;
import com.recall.backend.model.TicketRecord;
import com.recall.backend.service.LocalFallbackRecommender;

/**
 * Replays a dataset of resolved incidents in chronological order.
 *
 * <p>For each incident the recommender may only see incidents that closed strictly before it —
 * the same information a live system would have had at that moment. This is what makes the
 * result a forecast rather than a memory test: scoring against a corpus that already contains
 * the answer measures nothing.
 *
 * <p>The dataset defaults to the bundled sample and can be pointed at a real export with
 * {@code -Drecall.backtest.dataset=/path/to/incidents.json}. Do not commit real incident data.
 */
public final class BacktestRunner {

    public static final String DATASET_PROPERTY = "recall.backtest.dataset";
    private static final String BUNDLED_DATASET = "/backtest/sample-incidents.json";

    private final ObjectMapper mapper = new ObjectMapper();

    public List<BacktestCase> loadDataset() {
        String override = System.getProperty(DATASET_PROPERTY);
        try {
            if (override != null && !override.isBlank()) {
                byte[] bytes = Files.readAllBytes(Path.of(override));
                return sorted(mapper.readValue(bytes, mapper.getTypeFactory()
                    .constructCollectionType(List.class, BacktestCase.class)));
            }
            try (InputStream in = BacktestRunner.class.getResourceAsStream(BUNDLED_DATASET)) {
                if (in == null) {
                    throw new IllegalStateException("Missing bundled dataset " + BUNDLED_DATASET);
                }
                return sorted(mapper.readValue(in, mapper.getTypeFactory()
                    .constructCollectionType(List.class, BacktestCase.class)));
            }
        } catch (IOException ex) {
            throw new IllegalStateException("Could not load backtest dataset", ex);
        }
    }

    /**
     * Chronological order. A ticket with no usable timestamp sorts last rather than being dropped:
     * it still belongs in the corpus, it just cannot anchor a point in time.
     */
    private List<BacktestCase> sorted(List<BacktestCase> cases) {
        List<BacktestCase> out = new ArrayList<>(cases);
        out.sort(Comparator
            .comparing((BacktestCase c) -> c.changedDate == null || c.changedDate.isBlank() ? "9999" : c.changedDate)
            .thenComparing(c -> c.id));
        return out;
    }

    public BacktestReport run(List<BacktestCase> cases) {
        // A fresh recommender per run: feedback state must not leak between runs.
        LocalFallbackRecommender recommender = new LocalFallbackRecommender();
        List<BacktestResult> results = new ArrayList<>();

        for (int i = 0; i < cases.size(); i++) {
            BacktestCase target = cases.get(i);
            if (!target.hasGroundTruth()) {
                continue; // nothing to score against
            }

            List<BacktestCase> priorCases = cases.subList(0, i);
            if (priorCases.isEmpty()) {
                continue; // the first incident has nothing to learn from
            }

            boolean answerable = priorCases.stream()
                .anyMatch(c -> target.resolvedPatch.equals(c.resolvedPatch));

            RecommendResponse response = recommender.recommend(buildRequest(target, priorCases));
            results.add(score(target, response, answerable));
        }

        return new BacktestReport(results);
    }

    private RecommendRequest buildRequest(BacktestCase target, List<BacktestCase> priorCases) {
        RecommendRequest request = new RecommendRequest();

        QueryTicket query = new QueryTicket();
        query.title = target.title;
        query.description = target.description;
        query.severity = target.severity;
        query.system = target.system;
        // The resolution is deliberately withheld: at incident time nobody knows it yet.
        request.query = query;

        request.localCorpus = priorCases.stream().map(BacktestRunner::toTicket).toList();
        request.patches = knownPatches(priorCases);
        request.topK = 5;
        request.debug = false;
        return request;
    }

    /** The patch catalogue as it stood at that moment — fixes not yet invented are not offerable. */
    private List<PatchRecord> knownPatches(List<BacktestCase> priorCases) {
        Set<String> ids = new LinkedHashSet<>();
        for (BacktestCase c : priorCases) {
            if (c.hasGroundTruth()) ids.add(c.resolvedPatch);
        }
        return ids.stream().map(id -> {
            PatchRecord p = new PatchRecord();
            p.id = id;
            p.name = id;
            return p;
        }).toList();
    }

    private static TicketRecord toTicket(BacktestCase c) {
        TicketRecord t = new TicketRecord();
        t.id = c.id;
        t.title = c.title;
        t.description = c.description;
        t.system = c.system;
        t.severity = c.severity;
        t.resolvedPatch = c.resolvedPatch;
        t.resolutionDescription = c.resolutionDescription;
        t.changedDate = c.changedDate;
        t.source = c.source;
        return t;
    }

    private BacktestResult score(BacktestCase target, RecommendResponse response, boolean answerable) {
        List<Recommendation> recs = response.recommendations == null ? List.of() : response.recommendations;

        if (response.abstained || recs.isEmpty()) {
            return new BacktestResult(
                target.id,
                target.resolvedPatch,
                answerable,
                answerable ? Outcome.MISSED_ANSWER : Outcome.CORRECT_ABSTAIN,
                response.abstainCode == null ? "unknown" : response.abstainCode,
                0,
                0
            );
        }

        int rank = 0;
        for (int i = 0; i < recs.size(); i++) {
            if (target.resolvedPatch.equals(recs.get(i).patchId)) {
                rank = i + 1;
                break;
            }
        }

        Outcome outcome;
        if (rank == 1) {
            outcome = Outcome.CORRECT;
        } else if (answerable) {
            outcome = Outcome.WRONG_ANSWER;
        } else {
            outcome = Outcome.HALLUCINATED;
        }

        return new BacktestResult(target.id, target.resolvedPatch, answerable, outcome, null, rank,
            recs.get(0).confidence);
    }

    /** One scored incident. */
    public record BacktestResult(
        String incidentId,
        String expectedPatch,
        boolean answerable,
        Outcome outcome,
        String abstainCode,
        int rankOfExpected,
        int topConfidence
    ) {
    }
}
