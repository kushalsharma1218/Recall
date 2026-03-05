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

    @JsonProperty("abstainReason")
    public String abstainReason;

    public List<Recommendation> recommendations = new ArrayList<>();

    @JsonProperty("similarIncidents")
    public List<SimilarIncident> similarIncidents = new ArrayList<>();

    public Map<String, Object> debug = new LinkedHashMap<>();
}
