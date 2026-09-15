package com.recall.backend.telemetry;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Live KPIs computed from the decision log.
 *
 * <p>Grouped the way they should be read: can we trust it, is it useful, is it healthy. Every rate
 * ships alongside the denominator it was computed over, because a precision of 1.00 over three
 * labelled decisions is not a number anyone should act on.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public class KpiReport {

    // ── Volume and label coverage ────────────────────────────────────────────
    public int decisions;
    public int labelledDecisions;
    /** Share of decisions whose real outcome is known. Every accuracy figure below rests on this. */
    public double labelCoverage;
    /** Median seconds from decision to label. How stale the accuracy numbers necessarily are. */
    public long medianTimeToLabelSeconds;

    // ── Can we trust it (model quality) ──────────────────────────────────────
    public int answered;
    public int answeredAndLabelled;
    public int correct;
    /** Of the fixes proposed and since labelled, how many were the fix actually applied. */
    public double answerPrecision;
    /**
     * Answer precision over labelled decisions where the engineer did <em>not</em> report applying
     * our suggestion — so the outcome is not just our own recommendation echoed back to us.
     * Lower volume, far less circular. Trust this one over {@link #answerPrecision}.
     */
    public double independentPrecision;
    public int independentlyLabelled;

    // ── Is it useful (product impact) ────────────────────────────────────────
    public int abstentions;
    public double abstainRate;
    public double coverage;
    public Map<String, Integer> abstainsByCode = new LinkedHashMap<>();
    /** Abstentions that later turned out to have a recordable fix — the cost of being careful. */
    public int missedAnswers;
    /**
     * Of abstentions, how many produced a recorded fix afterwards. This is the capture loop: an
     * abstain that teaches the system something is a success, one that teaches it nothing is not.
     */
    public double captureRate;

    // ── Is it calibrated ─────────────────────────────────────────────────────
    /** Stated confidence band -> {observed accuracy, sample count}. */
    public Map<String, double[]> calibration = new LinkedHashMap<>();

    // ── Is it healthy (system) ───────────────────────────────────────────────
    public long latencyP50Ms;
    public long latencyP95Ms;
    public int medianCorpusSize;

    /**
     * Plain-language warnings about reading too much into the numbers above. Surfaced in the API
     * and on the dashboard so a thin sample cannot quietly be mistaken for a result.
     */
    public List<String> caveats = List.of();
}
