package com.recall.backend.service.gateway;

import java.util.Map;

import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;

public interface RecommendationGateway {

    String id();

    RecommendResponse recommend(RecommendRequest request);

    FeedbackResponse feedback(FeedbackRequest request);

    Map<String, Object> health();

    Map<String, Object> reload();
}
