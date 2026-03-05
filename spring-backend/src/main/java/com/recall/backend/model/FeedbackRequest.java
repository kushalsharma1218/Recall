package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;

@JsonIgnoreProperties(ignoreUnknown = true)
public class FeedbackRequest {
    @NotBlank
    public String patchId;

    @NotBlank
    public String vote;
}
