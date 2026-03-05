package com.recall.backend.service.gateway;

import java.util.Map;

import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.service.LegacyBackendClient;
import org.springframework.stereotype.Component;

@Component
public class ProxyRecommendationGateway implements RecommendationGateway {

    private final LegacyBackendClient legacyBackendClient;

    public ProxyRecommendationGateway(LegacyBackendClient legacyBackendClient) {
        this.legacyBackendClient = legacyBackendClient;
    }

    @Override
    public String id() {
        return "proxy";
    }

    @Override
    public RecommendResponse recommend(RecommendRequest request) {
        return legacyBackendClient.recommend(request);
    }

    @Override
    public FeedbackResponse feedback(FeedbackRequest request) {
        return legacyBackendClient.feedback(request);
    }

    @Override
    public Map<String, Object> health() {
        return legacyBackendClient.health();
    }

    @Override
    public Map<String, Object> reload() {
        return legacyBackendClient.reload();
    }
}
