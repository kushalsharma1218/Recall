package com.recall.backend.service;

import java.util.LinkedHashMap;
import java.util.Map;

import com.recall.backend.config.BackendProperties;
import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.RequestEntity;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

@Component
public class LegacyBackendClient {

    private final RestTemplate restTemplate;
    private final BackendProperties properties;

    public LegacyBackendClient(RestTemplate restTemplate, BackendProperties properties) {
        this.restTemplate = restTemplate;
        this.properties = properties;
    }

    public Map<String, Object> health() {
        String url = baseUrl() + "/health";
        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
            url,
            HttpMethod.GET,
            null,
            new ParameterizedTypeReference<>() {
            }
        );
        return response.getBody() == null ? new LinkedHashMap<>() : response.getBody();
    }

    public RecommendResponse recommend(RecommendRequest request) {
        String url = baseUrl() + "/v1/recommend";
        RequestEntity<RecommendRequest> httpRequest = RequestEntity
            .post(url)
            .contentType(MediaType.APPLICATION_JSON)
            .body(request);

        ResponseEntity<RecommendResponse> response = restTemplate.exchange(httpRequest, RecommendResponse.class);
        RecommendResponse body = response.getBody();
        if (body == null) {
            throw new RestClientException("Legacy backend returned empty recommend response");
        }
        return body;
    }

    public FeedbackResponse feedback(FeedbackRequest request) {
        String url = baseUrl() + "/v1/feedback";
        ResponseEntity<FeedbackResponse> response = restTemplate.exchange(
            url,
            HttpMethod.POST,
            new HttpEntity<>(request),
            FeedbackResponse.class
        );
        FeedbackResponse body = response.getBody();
        if (body == null) {
            throw new RestClientException("Legacy backend returned empty feedback response");
        }
        return body;
    }

    public Map<String, Object> reload() {
        String url = baseUrl() + "/v1/reload";
        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
            url,
            HttpMethod.POST,
            null,
            new ParameterizedTypeReference<>() {
            }
        );
        return response.getBody() == null ? new LinkedHashMap<>() : response.getBody();
    }

    private String baseUrl() {
        String raw = properties.getLegacyBaseUrl() == null ? "" : properties.getLegacyBaseUrl().trim();
        while (raw.endsWith("/")) {
            raw = raw.substring(0, raw.length() - 1);
        }
        if (raw.isBlank()) {
            throw new IllegalStateException("legacy-base-url is empty");
        }
        return raw;
    }
}
