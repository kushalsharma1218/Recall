package com.recall.backend.controller;

import java.util.Map;

import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.service.RecommenderService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

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
    public RecommendResponse recommend(@RequestBody RecommendRequest request) {
        try {
            return recommenderService.recommend(request);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage(), ex);
        } catch (RuntimeException ex) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "recommendation_failed: " + ex.getMessage(), ex);
        }
    }

    @PostMapping("/v1/feedback")
    public FeedbackResponse feedback(@Valid @RequestBody FeedbackRequest request) {
        try {
            return recommenderService.feedback(request);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage(), ex);
        } catch (RuntimeException ex) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "feedback_failed: " + ex.getMessage(), ex);
        }
    }

    @PostMapping("/v1/reload")
    public Map<String, Object> reload() {
        try {
            return recommenderService.reload();
        } catch (RuntimeException ex) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "reload_failed: " + ex.getMessage(), ex);
        }
    }
}
