package com.recall.backend.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class Recommendation {
    public String patchId;
    public int confidence;
    public double score;
    public String reasoning;
    public List<String> evidence = new ArrayList<>();
    public Map<String, Double> features = new LinkedHashMap<>();
}
