package com.recall.backend.service.gateway;

import java.util.Map;

import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.service.LocalFallbackRecommender;
import org.springframework.stereotype.Component;

@Component
public class LocalRecommendationGateway implements RecommendationGateway {

    private final LocalFallbackRecommender recommender;

    public LocalRecommendationGateway(LocalFallbackRecommender recommender) {
        this.recommender = recommender;
    }

    @Override
    public String id() {
        return "local";
    }

    @Override
    public RecommendResponse recommend(RecommendRequest request) {
        return recommender.recommend(request);
    }

    @Override
    public FeedbackResponse feedback(FeedbackRequest request) {
        return recommender.recordFeedback(request.patchId, request.vote);
    }

    @Override
    public Map<String, Object> health() {
        return recommender.health();
    }

    @Override
    public Map<String, Object> reload() {
        return recommender.reload();
    }
}
