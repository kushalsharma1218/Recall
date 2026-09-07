package com.recall.backend.eval;

import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import com.recall.backend.eval.BacktestRunner.BacktestResult;

/**
 * Metrics over a replayed dataset.
 *
 * <p>{@link #answerPrecision()} is the metric this product lives or dies by. During an outage a
 * wrong fix costs more than no fix, so coverage is traded away for precision, not the reverse.
 */
public final class BacktestReport {

    private final List<BacktestResult> results;
    private final Map<Outcome, Integer> counts = new EnumMap<>(Outcome.class);
    private final Map<String, Integer> abstainCodes = new TreeMap<>();

    public BacktestReport(List<BacktestResult> results) {
        this.results = List.copyOf(results);
        for (Outcome o : Outcome.values()) counts.put(o, 0);
        for (BacktestResult r : results) {
            counts.merge(r.outcome(), 1, Integer::sum);
            if (r.abstainCode() != null) abstainCodes.merge(r.abstainCode(), 1, Integer::sum);
        }
    }

    public int total() {
        return results.size();
    }

    public int count(Outcome outcome) {
        return counts.getOrDefault(outcome, 0);
    }

    /** Incidents where the engine committed to a fix. */
    public int answered() {
        return count(Outcome.CORRECT) + count(Outcome.WRONG_ANSWER) + count(Outcome.HALLUCINATED);
    }

    public int answerable() {
        return (int) results.stream().filter(BacktestResult::answerable).count();
    }

    public int unanswerable() {
        return total() - answerable();
    }

    /** Of the fixes we proposed, how many were the fix actually applied. The headline metric. */
    public double answerPrecision() {
        return ratio(count(Outcome.CORRECT), answered());
    }

    /** How often the engine was willing to answer at all. */
    public double coverage() {
        return ratio(answered(), total());
    }

    /** Of the incidents a prior fix could have solved, how many we actually solved. */
    public double answerableRecall() {
        return ratio(count(Outcome.CORRECT), answerable());
    }

    /** Answering on an incident whose fix was unprecedented. This should be zero. */
    public double hallucinationRate() {
        return ratio(count(Outcome.HALLUCINATED), unanswerable());
    }

    public double abstainRate() {
        return ratio(count(Outcome.MISSED_ANSWER) + count(Outcome.CORRECT_ABSTAIN), total());
    }

    public double recallAt(int k) {
        long hits = results.stream()
            .filter(BacktestResult::answerable)
            .filter(r -> r.rankOfExpected() >= 1 && r.rankOfExpected() <= k)
            .count();
        return ratio((int) hits, answerable());
    }

    public double meanReciprocalRank() {
        double sum = results.stream()
            .filter(BacktestResult::answerable)
            .mapToDouble(r -> r.rankOfExpected() >= 1 ? 1.0 / r.rankOfExpected() : 0.0)
            .sum();
        return answerable() == 0 ? 0.0 : sum / answerable();
    }

    public Map<String, Integer> abstainCodeCounts() {
        return new LinkedHashMap<>(abstainCodes);
    }

    /**
     * Observed accuracy per confidence band. A confidence number nobody has checked is decoration:
     * when the engine says 70, it should be right about 70% of the time.
     */
    public Map<String, double[]> calibration() {
        Map<String, int[]> buckets = new TreeMap<>();
        for (BacktestResult r : results) {
            if (r.outcome() == Outcome.MISSED_ANSWER || r.outcome() == Outcome.CORRECT_ABSTAIN) continue;
            int band = Math.min(9, r.topConfidence() / 10);
            String key = String.format("%2d-%2d", band * 10, band * 10 + 9);
            int[] cell = buckets.computeIfAbsent(key, k -> new int[2]);
            cell[0] += (r.outcome() == Outcome.CORRECT ? 1 : 0);
            cell[1] += 1;
        }
        Map<String, double[]> out = new LinkedHashMap<>();
        buckets.forEach((k, v) -> out.put(k, new double[]{ratio(v[0], v[1]), v[1]}));
        return out;
    }

    /** The incidents worth opening by hand: every case where the engine committed and was wrong. */
    public List<BacktestResult> damagingFailures() {
        return results.stream()
            .filter(r -> r.outcome() == Outcome.HALLUCINATED || r.outcome() == Outcome.WRONG_ANSWER)
            .sorted((a, b) -> Integer.compare(b.topConfidence(), a.topConfidence()))
            .toList();
    }

    private static double ratio(int numerator, int denominator) {
        return denominator == 0 ? 0.0 : (double) numerator / denominator;
    }

    private static String pct(double value) {
        return String.format("%5.1f%%", value * 100);
    }

    public String format() {
        StringBuilder sb = new StringBuilder();
        sb.append("\n=== Recall backtest =========================================\n");
        sb.append(String.format("  scored incidents      %4d   (%d answerable, %d unprecedented)%n",
            total(), answerable(), unanswerable()));
        sb.append("\n  OUTCOMES\n");
        sb.append(String.format("    correct             %4d%n", count(Outcome.CORRECT)));
        sb.append(String.format("    wrong answer        %4d   <- costs trust%n", count(Outcome.WRONG_ANSWER)));
        sb.append(String.format("    hallucinated        %4d   <- worst case%n", count(Outcome.HALLUCINATED)));
        sb.append(String.format("    missed (abstained)  %4d   <- safe but unhelpful%n", count(Outcome.MISSED_ANSWER)));
        sb.append(String.format("    correct abstain     %4d%n", count(Outcome.CORRECT_ABSTAIN)));
        sb.append("\n  METRICS\n");
        sb.append(String.format("    answer precision    %s   <- headline%n", pct(answerPrecision())));
        sb.append(String.format("    hallucination rate  %s   <- must stay ~0%n", pct(hallucinationRate())));
        sb.append(String.format("    coverage            %s%n", pct(coverage())));
        sb.append(String.format("    answerable recall   %s%n", pct(answerableRecall())));
        sb.append(String.format("    abstain rate        %s%n", pct(abstainRate())));
        sb.append(String.format("    recall@3            %s%n", pct(recallAt(3))));
        sb.append(String.format("    MRR                 %s%n", pct(meanReciprocalRank())));

        if (!abstainCodes.isEmpty()) {
            sb.append("\n  WHY IT ABSTAINED  (tells you which problem you actually have)\n");
            abstainCodes.forEach((code, n) -> sb.append(String.format("    %-22s %4d%n", code, n)));
        }

        Map<String, double[]> calibration = calibration();
        if (!calibration.isEmpty()) {
            sb.append("\n  CALIBRATION  (stated confidence vs observed accuracy)\n");
            calibration.forEach((band, v) ->
                sb.append(String.format("    %s  observed %s  (n=%d)%n", band, pct(v[0]), (int) v[1])));
        }
        List<BacktestResult> failures = damagingFailures();
        if (!failures.isEmpty()) {
            sb.append("\n  WRONG ANSWERS  (open these by hand - highest confidence first)\n");
            for (BacktestResult r : failures) {
                sb.append(String.format("    %-10s expected %-28s %s conf=%d%n",
                    r.incidentId(), r.expectedPatch(), r.outcome(), r.topConfidence()));
            }
        }
        sb.append("=============================================================\n");
        return sb.toString();
    }
}
