package com.recall.backend.eval;

/**
 * What happened on one replayed incident.
 *
 * <p>The split that matters for this product is between the two ways of being wrong.
 * {@link #MISSED_ANSWER} costs the user time; {@link #WRONG_ANSWER} and {@link #HALLUCINATED}
 * cost them trust, and are spent during an outage when attention is scarcest.
 */
public enum Outcome {
    /** Recommended the fix that was actually applied. */
    CORRECT,

    /** Recommended a fix, but not the one that was applied, when the right one was available. */
    WRONG_ANSWER,

    /** Recommended a fix for an incident whose real fix had never been seen before. The worst case. */
    HALLUCINATED,

    /** Abstained although a prior incident used the same fix. Safe, but unhelpful. */
    MISSED_ANSWER,

    /** Abstained on an incident whose fix was genuinely unprecedented. Exactly right. */
    CORRECT_ABSTAIN
}
