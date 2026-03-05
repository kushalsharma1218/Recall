package com.recall.backend.model;

import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public class RecommendRequest {
    public QueryTicket query = new QueryTicket();
    public List<PatchRecord> patches = new ArrayList<>();

    @JsonProperty("local_corpus")
    public List<TicketRecord> localCorpus = new ArrayList<>();

    @JsonProperty("top_k")
    public Integer topK = 5;

    public Boolean debug = false;

    @JsonProperty("embedding_model")
    public String embeddingModel = "nomic-embed-text";
}
