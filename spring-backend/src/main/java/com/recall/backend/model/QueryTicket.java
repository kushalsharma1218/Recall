package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class QueryTicket {
    public String title = "";
    public String description = "";
    // Deliberately blank, not "medium": a defaulted severity is indistinguishable from one the
    // user actually chose, and the recommender scores severity agreement.
    public String severity = "";
    public String system = "";
    public Object tags;
}
