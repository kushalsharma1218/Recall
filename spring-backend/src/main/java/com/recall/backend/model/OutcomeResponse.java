package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class OutcomeResponse {
    public boolean recorded;
    public String decisionId;
    public String message = "";

    public OutcomeResponse() {
    }

    public OutcomeResponse(boolean recorded, String decisionId, String message) {
        this.recorded = recorded;
        this.decisionId = decisionId;
        this.message = message;
    }
}
