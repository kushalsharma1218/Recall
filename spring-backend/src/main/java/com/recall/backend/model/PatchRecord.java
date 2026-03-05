package com.recall.backend.model;

import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class PatchRecord {
    public String id;
    public String name = "";
    public String description = "";
    public List<String> tags = new ArrayList<>();
    public String riskLevel = "medium";
    public String type = "template";
}
