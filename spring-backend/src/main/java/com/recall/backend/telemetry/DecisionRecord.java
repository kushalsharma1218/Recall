package com.recall.backend.telemetry;

import java.time.Duration;
import java.time.Instant;

/**
 * One recommendation decision, plus the outcome if one has arrived yet.
 *
 * <p>In production nobody tells you the right answer at the moment you answer. The label turns up
 * later — when the incident actually closes — so a decision and its outcome are recorded
 * separately and joined by {@code decisionId}.
 */
public final class DecisionRecord {

    public final String decisionId;
    public final Instant decidedAt;
    public final boolean abstained;
    public final String abstainCode;
    public final String topPatchId;
    public final int topConfidence;
    public final int recommendationCount;
    public final int corpusSize;
    public final long latencyMs;

    private Instant outcomeAt;
    private String appliedPatchId;
    private boolean suggestionAccepted;
    private String outcomeSource;

    DecisionRecord(
        String decisionId,
        Instant decidedAt,
        boolean abstained,
        String abstainCode,
        String topPatchId,
        int topConfidence,
        int recommendationCount,
        int corpusSize,
        long latencyMs
    ) {
        this.decisionId = decisionId;
        this.decidedAt = decidedAt;
        this.abstained = abstained;
        this.abstainCode = abstainCode;
        this.topPatchId = topPatchId;
        this.topConfidence = topConfidence;
        this.recommendationCount = recommendationCount;
        this.corpusSize = corpusSize;
        this.latencyMs = latencyMs;
    }

    void applyOutcome(String appliedPatchId, boolean suggestionAccepted, String outcomeSource, Instant at) {
        this.appliedPatchId = appliedPatchId;
        this.suggestionAccepted = suggestionAccepted;
        this.outcomeSource = outcomeSource;
        this.outcomeAt = at;
    }

    public boolean hasOutcome() {
        return outcomeAt != null;
    }

    public String appliedPatchId() {
        return appliedPatchId;
    }

    public String outcomeSource() {
        return outcomeSource;
    }

    /**
     * Whether the engineer said they applied what we suggested.
     *
     * <p>This is the flag that keeps the numbers honest. If we suggest fix A, the engineer applies
     * fix A because we said so, and the ticket then records fix A, our "ground truth" is just our
     * own suggestion echoed back. Precision computed over those rows measures compliance, not
     * accuracy — see {@link KpiReport#independentPrecision}.
     */
    public boolean suggestionAccepted() {
        return suggestionAccepted;
    }

    /** True when we proposed a fix and the fix actually applied was that one. */
    public boolean answeredCorrectly() {
        return !abstained
            && topPatchId != null
            && hasOutcome()
            && topPatchId.equals(appliedPatchId);
    }

    /** True when we declined but the incident did turn out to have a recordable fix. */
    public boolean missedAnswer() {
        return abstained && hasOutcome() && appliedPatchId != null && !appliedPatchId.isBlank();
    }

    public long timeToLabelSeconds() {
        return hasOutcome() ? Math.max(0, Duration.between(decidedAt, outcomeAt).toSeconds()) : -1;
    }
}
