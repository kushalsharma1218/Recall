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
import com.recall.backend.service.gateway.LocalRecommendationGateway;
import com.recall.backend.service.gateway.ProxyRecommendationGateway;
import com.recall.backend.service.resilience.LegacyCircuitBreaker;
import org.springframework.stereotype.Service;

@Service
public class RecommenderService {

    private final BackendProperties properties;
    private final ProxyRecommendationGateway proxyGateway;
    private final LocalRecommendationGateway localGateway;
    private final LegacyCircuitBreaker legacyCircuitBreaker;

    public RecommenderService(
        BackendProperties properties,
        ProxyRecommendationGateway proxyGateway,
        LocalRecommendationGateway localGateway,
        LegacyCircuitBreaker legacyCircuitBreaker
    ) {
        this.properties = properties;
        this.proxyGateway = proxyGateway;
        this.localGateway = localGateway;
        this.legacyCircuitBreaker = legacyCircuitBreaker;
    }

    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("engine", "spring-bridge");
        out.put("mode", properties.getMode().name().toLowerCase());
        out.put("legacy_configured", !String.valueOf(properties.getLegacyBaseUrl()).trim().isBlank());
        out.put("legacy_host", safeHost(properties.getLegacyBaseUrl()));
        out.put("fallback_enabled", properties.isFallbackEnabled());
        out.put("legacy_circuit", legacyCircuitBreaker.state());

        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            out.put("legacy_ok", false);
            out.putAll(localGateway.health());
            return out;
        }

        if (!legacyCircuitBreaker.allowRequest()) {
            out.put("legacy_ok", false);
            out.put("warning", "Legacy backend circuit open");
            Map<String, Object> localHealth = localGateway.health();
            out.put("tickets_loaded", asInt(localHealth.get("tickets_loaded"), 0));
            out.put("ollama_reachable", asBoolean(localHealth.get("ollama_reachable"), false));
            return out;
        }

        try {
            Map<String, Object> legacy = proxyGateway.health();
            legacyCircuitBreaker.recordSuccess();
            out.put("legacy_ok", true);
            out.put("tickets_loaded", asInt(legacy.get("tickets_loaded"), 0));
            out.put("ollama_reachable", asBoolean(legacy.get("ollama_reachable"), false));
            out.put("legacy_engine", String.valueOf(legacy.getOrDefault("engine", "unknown")));
        } catch (RuntimeException ex) {
            legacyCircuitBreaker.recordFailure();
            out.put("legacy_ok", false);
            out.put("tickets_loaded", 0);
            out.put("ollama_reachable", false);
            out.put("warning", "Legacy backend unreachable");
        }

        return out;
    }

    public RecommendResponse recommend(RecommendRequest request) {
        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            return localGateway.recommend(request);
        }

        if (!legacyCircuitBreaker.allowRequest()) {
            if (!properties.isFallbackEnabled()) {
                throw new IllegalStateException("Legacy backend temporarily unavailable (circuit open)");
            }
            return fallbackRecommend(request, "legacy_circuit_open");
        }

        try {
            RecommendResponse response = proxyGateway.recommend(request);
            legacyCircuitBreaker.recordSuccess();
            return response;
        } catch (RuntimeException ex) {
            legacyCircuitBreaker.recordFailure();
            if (!properties.isFallbackEnabled()) {
                throw ex;
            }
            return fallbackRecommend(request, "legacy_unavailable");
        }
    }

    public FeedbackResponse feedback(FeedbackRequest request) {
        String vote = request.vote == null ? "" : request.vote.trim().toLowerCase();
        if (!"up".equals(vote) && !"down".equals(vote)) {
            throw new IllegalArgumentException("vote must be 'up' or 'down'");
        }

        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            return localGateway.feedback(request);
        }

        if (!legacyCircuitBreaker.allowRequest()) {
            if (!properties.isFallbackEnabled()) {
                throw new IllegalStateException("Legacy backend temporarily unavailable (circuit open)");
            }
            return localGateway.feedback(request);
        }

        try {
            FeedbackResponse response = proxyGateway.feedback(request);
            legacyCircuitBreaker.recordSuccess();
            return response;
        } catch (RuntimeException ex) {
            legacyCircuitBreaker.recordFailure();
            if (!properties.isFallbackEnabled()) {
                throw ex;
            }
            return localGateway.feedback(request);
        }
    }

    public Map<String, Object> reload() {
        Map<String, Object> out = new LinkedHashMap<>();

        if (properties.getMode() == BackendProperties.Mode.LOCAL) {
            out.putAll(localGateway.reload());
            out.put("mode", "local");
            return out;
        }

        if (!legacyCircuitBreaker.allowRequest()) {
            if (!properties.isFallbackEnabled()) {
                throw new IllegalStateException("Legacy backend temporarily unavailable (circuit open)");
            }
            out.putAll(localGateway.reload());
            out.put("mode", "local-fallback");
            out.put("warning", "Legacy reload skipped: circuit open");
            return out;
        }

        try {
            Map<String, Object> legacy = proxyGateway.reload();
            legacyCircuitBreaker.recordSuccess();
            out.putAll(legacy);
            out.put("mode", "proxy");
            return out;
        } catch (RuntimeException ex) {
            legacyCircuitBreaker.recordFailure();
            if (!properties.isFallbackEnabled()) {
                throw ex;
            }
            out.putAll(localGateway.reload());
            out.put("mode", "local-fallback");
            out.put("warning", "Legacy reload unavailable");
            return out;
        }
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

    private RecommendResponse fallbackRecommend(RecommendRequest request, String reason) {
        RecommendResponse fallback = localGateway.recommend(request);
        if (fallback.debug == null) fallback.debug = new LinkedHashMap<>();
        fallback.debug.put("bridge_fallback", true);
        fallback.debug.put("bridge_error", reason);
        fallback.debug.put("circuit_open", legacyCircuitBreaker.isOpen());
        fallback.debug.put("circuit_failure_count", legacyCircuitBreaker.failureCount());
        fallback.debug.put("fallback_at", Instant.now().toString());
        return fallback;
    }

}
