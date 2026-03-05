package com.recall.backend.config;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "recall.backend")
public class BackendProperties {

    public enum Mode {
        PROXY,
        LOCAL
    }

    private Mode mode = Mode.PROXY;
    private String legacyBaseUrl = "http://127.0.0.1:8000";
    private long requestTimeoutMs = 12000;
    private long healthTimeoutMs = 5000;
    private boolean fallbackEnabled = true;
    private List<String> allowedOrigins = List.of(
        "http://localhost:*",
        "http://127.0.0.1:*",
        "https://localhost:*",
        "https://127.0.0.1:*"
    );

    public Mode getMode() {
        return mode;
    }

    public void setMode(Mode mode) {
        this.mode = mode;
    }

    public String getLegacyBaseUrl() {
        return legacyBaseUrl;
    }

    public void setLegacyBaseUrl(String legacyBaseUrl) {
        this.legacyBaseUrl = legacyBaseUrl;
    }

    public long getRequestTimeoutMs() {
        return requestTimeoutMs;
    }

    public void setRequestTimeoutMs(long requestTimeoutMs) {
        this.requestTimeoutMs = requestTimeoutMs;
    }

    public long getHealthTimeoutMs() {
        return healthTimeoutMs;
    }

    public void setHealthTimeoutMs(long healthTimeoutMs) {
        this.healthTimeoutMs = healthTimeoutMs;
    }

    public boolean isFallbackEnabled() {
        return fallbackEnabled;
    }

    public void setFallbackEnabled(boolean fallbackEnabled) {
        this.fallbackEnabled = fallbackEnabled;
    }

    public List<String> getAllowedOrigins() {
        return allowedOrigins;
    }

    public void setAllowedOrigins(List<String> allowedOrigins) {
        this.allowedOrigins = allowedOrigins;
    }
}
