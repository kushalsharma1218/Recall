package com.recall.backend.service;

import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import com.recall.backend.config.BackendProperties;
import com.recall.backend.model.FeedbackRequest;
import com.recall.backend.model.FeedbackResponse;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import org.springframework.stereotype.Service;

@Service
public class RecommenderService {

    private final BackendProperties properties;
    private final LegacyBackendClient legacyBackendClient;
    private final LocalFallbackRecommender localFallbackRecommender;

    public RecommenderService(
        BackendProperties properties,
        LegacyBackendClient legacyBackendClient,
        LocalFallbackRecommender localFallbackRecommender
    ) {
        this.properties = properties;
        this.legacyBackendClient = legacyBackendClient;
        this.localFallbackRecommender = localFallbackRecommender;
    }

    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("engine", "spring-bridge");
        out.put("mode", properties.getMode().name().toLowerCase());
        out.put("legacy_configured", !String.valueOf(properties.getLegacyBaseUrl()).trim().isBlank());
        out.put("legacy_host", safeHost(properties.getLegacyBaseUrl()));

        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            out.put("legacy_ok", false);
            out.put("tickets_loaded", 0);
            out.put("ollama_reachable", false);
            out.put("fallback_enabled", properties.isFallbackEnabled());
            return out;
        }

        try {
            Map<String, Object> legacy = legacyBackendClient.health();
            out.put("legacy_ok", true);
            out.put("tickets_loaded", asInt(legacy.get("tickets_loaded"), 0));
            out.put("ollama_reachable", asBoolean(legacy.get("ollama_reachable"), false));
            out.put("legacy_engine", String.valueOf(legacy.getOrDefault("engine", "unknown")));
        } catch (RuntimeException ex) {
            out.put("legacy_ok", false);
            out.put("tickets_loaded", 0);
            out.put("ollama_reachable", false);
            out.put("warning", "Legacy backend unreachable");
        }

        return out;
    }

    public RecommendResponse recommend(RecommendRequest request) {
        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            return localFallbackRecommender.recommend(request);
        }

        try {
            return legacyBackendClient.recommend(request);
        } catch (RuntimeException ex) {
            if (!properties.isFallbackEnabled()) {
                throw ex;
            }
            RecommendResponse fallback = localFallbackRecommender.recommend(request);
            fallback.debug.put("bridge_fallback", true);
            fallback.debug.put("bridge_error", "legacy_unavailable");
            return fallback;
        }
    }

    public FeedbackResponse feedback(FeedbackRequest request) {
        String vote = request.vote == null ? "" : request.vote.trim().toLowerCase();
        if (!"up".equals(vote) && !"down".equals(vote)) {
            throw new IllegalArgumentException("vote must be 'up' or 'down'");
        }

        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            return localFeedback(request.patchId, vote);
        }

        try {
            return legacyBackendClient.feedback(request);
        } catch (RuntimeException ex) {
            if (!properties.isFallbackEnabled()) {
                throw ex;
            }
            return localFeedback(request.patchId, vote);
        }
    }

    public Map<String, Object> reload() {
        Map<String, Object> out = new LinkedHashMap<>();

        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            out.put("ok", true);
            out.put("mode", "local");
            out.put("reloaded_at", Instant.now().toString());
            return out;
        }

        try {
            Map<String, Object> legacy = legacyBackendClient.reload();
            out.putAll(legacy);
            out.put("mode", "proxy");
            return out;
        } catch (RuntimeException ex) {
            if (!properties.isFallbackEnabled()) {
                throw ex;
            }
            out.put("ok", true);
            out.put("mode", "local-fallback");
            out.put("warning", "Legacy reload unavailable");
            out.put("reloaded_at", Instant.now().toString());
            return out;
        }
    }

    private FeedbackResponse localFeedback(String patchId, String vote) {
        return localFallbackRecommender.recordFeedback(patchId, vote);
    }

    private int asInt(Object value, int defaultVal) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        if (value == null) {
            return defaultVal;
        }
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (NumberFormatException ex) {
            return defaultVal;
        }
    }

    private boolean asBoolean(Object value, boolean defaultVal) {
        if (value instanceof Boolean b) {
            return b;
        }
        if (value == null) {
            return defaultVal;
        }
        return "true".equalsIgnoreCase(String.valueOf(value));
    }

    private String safeHost(String rawUrl) {
        try {
            URI uri = URI.create(String.valueOf(rawUrl));
            return uri.getHost() == null ? "" : uri.getHost();
        } catch (RuntimeException ex) {
            return "";
        }
    }

}
