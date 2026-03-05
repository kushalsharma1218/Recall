package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class QueryTicket {
    public String title = "";
    public String description = "";
    public String severity = "medium";
    public String system = "";
    public Object tags;
}
