package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;

/**
 * The real outcome of an incident, reported once it is actually resolved.
 *
 * <p>This is what turns Recall from a system with opinions into a system with a measured accuracy.
 * The label is worth far more when it comes from the ticket system than from a thumbs-up: the
 * former records what fixed the incident, the latter records how someone felt about a suggestion.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class OutcomeRequest {

    /** Links back to the decision, from {@code decisionId} on the recommend response. */
    @NotBlank
    public String decisionId;

    /** The fix actually applied. Blank is meaningful: the incident closed without a reusable fix. */
    public String appliedPatchId = "";

    /**
     * Whether the engineer applied what we suggested. Set this honestly — it is what separates
     * "we were right" from "they did what we told them and the ticket now agrees with us".
     */
    public boolean suggestionAccepted = false;

    /** Where the label came from: {@code ticket-system}, {@code engineer}, {@code backfill}. */
    public String source = "";
}
