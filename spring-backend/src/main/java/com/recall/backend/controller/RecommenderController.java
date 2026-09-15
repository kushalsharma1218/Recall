package com.recall.backend.controller;

import java.util.Map;

import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.OutcomeRequest;
import com.recall.backend.model.OutcomeResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.service.RecommenderService;
import com.recall.backend.telemetry.KpiReport;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RecommenderController {

    private final RecommenderService recommenderService;

    public RecommenderController(RecommenderService recommenderService) {
        this.recommenderService = recommenderService;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        return recommenderService.health();
    }

    @PostMapping("/v1/recommend")
    public RecommendResponse recommend(@Valid @RequestBody RecommendRequest request) {
        return recommenderService.recommend(request);
    }

    @PostMapping("/v1/feedback")
    public FeedbackResponse feedback(@Valid @RequestBody FeedbackRequest request) {
        return recommenderService.feedback(request);
    }

    @PostMapping("/v1/reload")
    public Map<String, Object> reload() {
        return recommenderService.reload();
    }

    /**
     * Reports what actually resolved an incident. This is the only way the service learns whether
     * its recommendations were right, so it is the endpoint that makes the KPIs below mean anything.
     */
    @PostMapping("/v1/outcome")
    public OutcomeResponse outcome(@Valid @RequestBody OutcomeRequest request) {
        boolean recorded = recommenderService.recordOutcome(
            request.decisionId, request.appliedPatchId, request.suggestionAccepted, request.source);

        return recorded
            ? new OutcomeResponse(true, request.decisionId, "Outcome recorded")
            : new OutcomeResponse(false, request.decisionId,
                "Unknown decisionId — it may have aged out of the decision window");
    }

    /** Live accuracy and health KPIs over the recent decision window. */
    @GetMapping("/v1/metrics")
    public KpiReport metrics() {
        return recommenderService.metrics();
    }
}
