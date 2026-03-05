package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class SimilarIncident {
    public String ticketId;
    public String title;
    public double similarity;
    public String resolvedPatch;
    public String resolutionDescription = "";
    public String severity = "";
    public String system = "";
    public String source = "";
}
