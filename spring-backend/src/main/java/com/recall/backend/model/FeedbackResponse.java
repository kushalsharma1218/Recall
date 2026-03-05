package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class FeedbackResponse {
    public String patchId;
    public int positive;
    public int negative;

    public FeedbackResponse() {
    }

    public FeedbackResponse(String patchId, int positive, int negative) {
        this.patchId = patchId;
        this.positive = positive;
        this.negative = negative;
    }
}
