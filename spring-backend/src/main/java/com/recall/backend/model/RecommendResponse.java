package com.recall.backend.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public class RecommendResponse {
    public String engine = "spring-bridge";
    public boolean abstained = false;

    /**
     * Stable machine-readable reason for an abstain, so callers can branch without parsing prose.
     * One of: {@code empty_corpus}, {@code empty_query}, {@code no_patch_evidence},
     * {@code weak_evidence}, {@code ambiguous_evidence}. Null when not abstaining.
     */
    @JsonProperty("abstainCode")
    public String abstainCode;

    @JsonProperty("abstainReason")
    public String abstainReason;

    /**
     * True when the correct next step is to ask the on-call engineer for a resolution and add it
     * to the corpus, rather than to show a guessed fix. False for abstains caused by a malformed
     * query, where the request itself is what needs fixing.
     */
    @JsonProperty("needsResolutionInput")
    public boolean needsResolutionInput = false;

    public List<Recommendation> recommendations = new ArrayList<>();

    @JsonProperty("similarIncidents")
    public List<SimilarIncident> similarIncidents = new ArrayList<>();

    /**
     * Identifies this decision so the caller can report the real outcome later via
     * {@code POST /v1/outcome}. Without it there is no way to learn whether we were right.
     */
    @JsonProperty("decisionId")
    public String decisionId;

    public Map<String, Object> debug = new LinkedHashMap<>();
}
