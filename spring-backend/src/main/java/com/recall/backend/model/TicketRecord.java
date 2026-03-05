package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class TicketRecord {
    public Object id;
    public String title = "";
    public String description = "";
    public String severity = "medium";
    public String system = "";
    public Object tags;
    public String resolvedPatch;
    public String resolutionDescription = "";
    public String status = "";
    public String outcome = "";
    public String source = "local";
    public String changedDate;
}
