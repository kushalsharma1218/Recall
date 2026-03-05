package com.recall.backend.model;

import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

@JsonIgnoreProperties(ignoreUnknown = true)
public class RecommendRequest {
    @NotNull
    @Valid
    public QueryTicket query = new QueryTicket();

    @NotNull
    @Valid
    public List<PatchRecord> patches = new ArrayList<>();

    @NotNull
    @Valid
    @JsonProperty("local_corpus")
    public List<TicketRecord> localCorpus = new ArrayList<>();

    @NotNull
    @Min(1)
    @Max(10)
    @JsonProperty("top_k")
    public Integer topK = 5;

    public Boolean debug = false;

    @JsonProperty("embedding_model")
    public String embeddingModel = "nomic-embed-text";
}
