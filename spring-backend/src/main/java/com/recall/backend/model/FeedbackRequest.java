package com.recall.backend.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

@JsonIgnoreProperties(ignoreUnknown = true)
public class FeedbackRequest {
    @NotBlank
    public String patchId;

    @NotBlank
    @Pattern(regexp = "(?i)up|down", message = "vote must be 'up' or 'down'")
    public String vote;
}
