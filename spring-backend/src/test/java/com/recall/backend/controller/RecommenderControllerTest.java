package com.recall.backend.controller;

import com.recall.backend.model.RecommendResponse;
import com.recall.backend.service.RecommenderService;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Pins the HTTP contract the frontend depends on. */
@WebMvcTest(RecommenderController.class)
class RecommenderControllerTest {

    private static final String VALID_BODY = """
        {"query":{"title":"Deadlock","description":"error 1205"},"patches":[],"local_corpus":[],"top_k":5}
        """;

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private RecommenderService recommenderService;

    /** The UI branches on these fields to decide whether to show a fix or ask for one. */
    @Test
    void abstainResponseExposesCodeAndResolutionPrompt() throws Exception {
        RecommendResponse abstained = new RecommendResponse();
        abstained.abstained = true;
        abstained.abstainCode = "no_similar_incident";
        abstained.abstainReason = "No past incident resembles this one closely enough to learn from.";
        abstained.needsResolutionInput = true;
        when(recommenderService.recommend(any())).thenReturn(abstained);

        mockMvc.perform(post("/v1/recommend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.abstained").value(true))
            .andExpect(jsonPath("$.abstainCode").value("no_similar_incident"))
            .andExpect(jsonPath("$.needsResolutionInput").value(true))
            .andExpect(jsonPath("$.recommendations").isEmpty());
    }

    @Test
    void nonAbstainResponseDoesNotAskForAResolution() throws Exception {
        when(recommenderService.recommend(any())).thenReturn(new RecommendResponse());

        mockMvc.perform(post("/v1/recommend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.abstained").value(false))
            .andExpect(jsonPath("$.needsResolutionInput").value(false));
    }

    @Test
    void rejectsOutOfRangeTopK() throws Exception {
        String body = """
            {"query":{"title":"Deadlock"},"patches":[],"local_corpus":[],"top_k":99}
            """;

        mockMvc.perform(post("/v1/recommend").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"))
            .andExpect(jsonPath("$.message").value(Matchers.containsString("topK")));
    }

    @Test
    void rejectsAnUnknownFeedbackVote() throws Exception {
        mockMvc.perform(post("/v1/feedback")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"patchId\":\"patch_a\",\"vote\":\"sideways\"}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"));
    }

    @Test
    void reportsDownstreamUnavailabilityAs503() throws Exception {
        when(recommenderService.recommend(any()))
            .thenThrow(new IllegalStateException("Legacy backend temporarily unavailable (circuit open)"));

        mockMvc.perform(post("/v1/recommend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.error").value("service_unavailable"));
    }

    /**
     * An unexpected fault is a defect here, not a downstream outage: 503 told clients to retry a
     * request that will fail identically, and the raw exception message leaked to the browser.
     */
    @Test
    void reportsUnexpectedFaultsAs500WithoutLeakingInternals() throws Exception {
        when(recommenderService.recommend(any()))
            .thenThrow(new NullPointerException("Cannot invoke \"String.length()\" because \"secret\" is null"));

        mockMvc.perform(post("/v1/recommend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
            .andExpect(status().isInternalServerError())
            .andExpect(jsonPath("$.error").value("internal_error"))
            .andExpect(jsonPath("$.message").value("Unexpected backend error"));
    }
}
