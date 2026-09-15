package com.recall.backend.telemetry;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

import com.recall.backend.model.RecommendResponse;
import com.recall.backend.model.Recommendation;
import org.springframework.stereotype.Component;

/**
 * Records every recommendation decision and the outcome that arrives later, and computes live KPIs.
 *
 * <p>The backtest answers "how good was the ranker on history we already have". This answers the
 * different question "what is actually happening now", which no offline replay can tell you:
 * production traffic is not the past, and the corpus changes under it.
 *
 * <p>Bounded and in-memory, so it resets on restart and reports a rolling window rather than
 * all-time history. That is a deliberate stage-appropriate choice, not an oversight — moving this
 * to Postgres is Stage 3 in the roadmap, at which point the same KPIs become durable and
 * long-range. Nothing else in the service depends on it being in memory.
 */
@Component
public class DecisionLog {

    /** Rolling window. At a few hundred incidents a year this is many years of real traffic. */
    static final int MAX_RECORDS = 10_000;

    /** Below this many labels, a rate is noise dressed up as a measurement. */
    private static final int MIN_SAMPLE_FOR_CONFIDENCE = 30;

    private final Map<String, DecisionRecord> records = Collections.synchronizedMap(
        new LinkedHashMap<>(512, 0.75f, false) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, DecisionRecord> eldest) {
                return size() > MAX_RECORDS;
            }
        });

    /**
     * Records a decision and returns its id. The id goes back to the caller in the response so the
     * eventual outcome can be joined to the decision that produced it.
     */
    public String record(RecommendResponse response, int corpusSize, long latencyMs) {
        String decisionId = UUID.randomUUID().toString();

        List<Recommendation> recs = response.recommendations == null ? List.of() : response.recommendations;
        Recommendation top = recs.isEmpty() ? null : recs.get(0);

        DecisionRecord record = new DecisionRecord(
            decisionId,
            Instant.now(),
            response.abstained,
            response.abstainCode,
            top == null ? null : top.patchId,
            top == null ? 0 : top.confidence,
            recs.size(),
            corpusSize,
            latencyMs
        );

        records.put(decisionId, record);
        return decisionId;
    }

    /**
     * Attaches the real outcome to an earlier decision.
     *
     * @param appliedPatchId     the fix actually applied, or blank if the incident closed without one
     * @param suggestionAccepted whether the engineer reported using what we suggested
     * @param source             where the label came from, e.g. {@code ticket-system} or {@code engineer}
     * @return false when the decision is unknown — typically aged out of the window, or a bad id
     */
    public boolean recordOutcome(String decisionId, String appliedPatchId, boolean suggestionAccepted, String source) {
        if (decisionId == null || decisionId.isBlank()) {
            throw new IllegalArgumentException("decisionId is required");
        }
        synchronized (records) {
            DecisionRecord record = records.get(decisionId);
            if (record == null) return false;
            record.applyOutcome(
                appliedPatchId == null ? "" : appliedPatchId.trim(),
                suggestionAccepted,
                source == null || source.isBlank() ? "unspecified" : source.trim(),
                Instant.now()
            );
            return true;
        }
    }

    public int size() {
        return records.size();
    }

    public void clear() {
        records.clear();
    }

    public KpiReport snapshot() {
        List<DecisionRecord> all;
        synchronized (records) {
            all = new ArrayList<>(records.values());
        }

        KpiReport kpi = new KpiReport();
        kpi.decisions = all.size();
        if (all.isEmpty()) {
            kpi.caveats = List.of("No decisions recorded yet.");
            return kpi;
        }

        List<DecisionRecord> labelled = all.stream().filter(DecisionRecord::hasOutcome).toList();
        List<DecisionRecord> answered = all.stream().filter(r -> !r.abstained).toList();
        List<DecisionRecord> answeredLabelled = answered.stream().filter(DecisionRecord::hasOutcome).toList();
        List<DecisionRecord> abstained = all.stream().filter(r -> r.abstained).toList();

        kpi.labelledDecisions = labelled.size();
        kpi.labelCoverage = ratio(labelled.size(), all.size());
        kpi.medianTimeToLabelSeconds = (long) median(
            labelled.stream().mapToDouble(DecisionRecord::timeToLabelSeconds).sorted().toArray());

        kpi.answered = answered.size();
        kpi.answeredAndLabelled = answeredLabelled.size();
        kpi.correct = (int) answeredLabelled.stream().filter(DecisionRecord::answeredCorrectly).count();
        kpi.answerPrecision = ratio(kpi.correct, answeredLabelled.size());

        // Strip the rows where our own suggestion became the ground truth.
        List<DecisionRecord> independent = answeredLabelled.stream()
            .filter(r -> !r.suggestionAccepted())
            .toList();
        kpi.independentlyLabelled = independent.size();
        kpi.independentPrecision = ratio(
            (int) independent.stream().filter(DecisionRecord::answeredCorrectly).count(),
            independent.size());

        kpi.abstentions = abstained.size();
        kpi.abstainRate = ratio(abstained.size(), all.size());
        kpi.coverage = ratio(answered.size(), all.size());
        kpi.missedAnswers = (int) abstained.stream().filter(DecisionRecord::missedAnswer).count();
        kpi.captureRate = ratio(kpi.missedAnswers, abstained.size());

        Map<String, Integer> byCode = new TreeMap<>();
        for (DecisionRecord r : abstained) {
            byCode.merge(r.abstainCode == null ? "unknown" : r.abstainCode, 1, Integer::sum);
        }
        kpi.abstainsByCode = new LinkedHashMap<>(byCode);

        kpi.calibration = calibration(answeredLabelled);

        double[] latencies = all.stream().mapToDouble(r -> r.latencyMs).sorted().toArray();
        kpi.latencyP50Ms = (long) percentile(latencies, 0.50);
        kpi.latencyP95Ms = (long) percentile(latencies, 0.95);
        kpi.medianCorpusSize = (int) median(all.stream().mapToDouble(r -> r.corpusSize).sorted().toArray());

        kpi.caveats = caveats(kpi);
        return kpi;
    }

    private Map<String, double[]> calibration(List<DecisionRecord> answeredLabelled) {
        Map<String, int[]> buckets = new TreeMap<>();
        for (DecisionRecord r : answeredLabelled) {
            int band = Math.min(9, Math.max(0, r.topConfidence / 10));
            String key = String.format("%02d-%02d", band * 10, band * 10 + 9);
            int[] cell = buckets.computeIfAbsent(key, k -> new int[2]);
            if (r.answeredCorrectly()) cell[0]++;
            cell[1]++;
        }
        Map<String, double[]> out = new LinkedHashMap<>();
        buckets.forEach((band, cell) -> out.put(band, new double[]{ratio(cell[0], cell[1]), cell[1]}));
        return out;
    }

    /**
     * Says out loud what the numbers cannot support. A dashboard that shows a confident 100% over
     * four labelled decisions does more harm than one showing nothing at all.
     */
    private List<String> caveats(KpiReport kpi) {
        List<String> out = new ArrayList<>();

        if (kpi.answeredAndLabelled < MIN_SAMPLE_FOR_CONFIDENCE) {
            out.add(String.format(
                "Only %d answered decisions have a known outcome; precision is indicative at best below %d.",
                kpi.answeredAndLabelled, MIN_SAMPLE_FOR_CONFIDENCE));
        }
        if (kpi.labelCoverage < 0.5 && kpi.decisions >= 10) {
            out.add(String.format(
                "Outcomes are known for only %.0f%% of decisions. Accuracy here describes that subset, "
                    + "which is unlikely to be representative.", kpi.labelCoverage * 100));
        }
        if (kpi.answeredAndLabelled > 0 && kpi.independentlyLabelled < kpi.answeredAndLabelled / 2) {
            out.add("Most labels come from incidents where our own suggestion was applied, so "
                + "answerPrecision is partly circular. Read independentPrecision instead.");
        }
        // independentPrecision is the figure worth trusting, so its own sample size has to be
        // held to the same bar — pointing at a cleaner metric computed over eight rows is no
        // better than quoting the circular one.
        if (kpi.independentlyLabelled > 0 && kpi.independentlyLabelled < MIN_SAMPLE_FOR_CONFIDENCE) {
            out.add(String.format(
                "independentPrecision rests on only %d non-circular labels; it is the right metric "
                    + "but not yet a reliable number.", kpi.independentlyLabelled));
        }
        if (kpi.abstentions > 0 && kpi.captureRate < 0.2) {
            out.add(String.format(
                "Only %.0f%% of abstentions led to a recorded fix. The engine is asking for fixes "
                    + "it is not getting, so the corpus is not learning from them.", kpi.captureRate * 100));
        }
        // Precision on abstained decisions is unobservable: we never find out what we would have
        // said. Flag it rather than letting the dashboard imply the abstain gate is measured.
        if (kpi.abstentions > 0) {
            out.add("Abstention quality is not directly measurable in production — we never learn "
                + "what we would have recommended. Use the offline backtest for that.");
        }
        return out;
    }

    private static double ratio(int numerator, int denominator) {
        return denominator == 0 ? 0.0 : (double) numerator / denominator;
    }

    private static double median(double[] sorted) {
        return percentile(sorted, 0.50);
    }

    private static double percentile(double[] sorted, double p) {
        if (sorted.length == 0) return 0.0;
        int index = (int) Math.ceil(p * sorted.length) - 1;
        return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
    }
}
