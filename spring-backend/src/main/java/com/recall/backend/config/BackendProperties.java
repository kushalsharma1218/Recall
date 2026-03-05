package com.recall.backend.config;

import java.util.List;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "recall.backend")
public class BackendProperties {

    public enum Mode {
        PROXY,
        LOCAL
    }

    private Mode mode = Mode.PROXY;
    private String legacyBaseUrl = "http://127.0.0.1:8000";
    @Min(500)
    @Max(120000)
    private long requestTimeoutMs = 12000;

    @Min(500)
    @Max(120000)
    private long healthTimeoutMs = 5000;

    private boolean fallbackEnabled = true;

    @Min(1)
    @Max(20)
    private int legacyFailureThreshold = 3;

    @Min(1000)
    @Max(300000)
    private long legacyCooldownMs = 15000;

    @NotEmpty
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

    public int getLegacyFailureThreshold() {
        return legacyFailureThreshold;
    }

    public void setLegacyFailureThreshold(int legacyFailureThreshold) {
        this.legacyFailureThreshold = legacyFailureThreshold;
    }

    public long getLegacyCooldownMs() {
        return legacyCooldownMs;
    }

    public void setLegacyCooldownMs(long legacyCooldownMs) {
        this.legacyCooldownMs = legacyCooldownMs;
    }

    public List<String> getAllowedOrigins() {
        return allowedOrigins;
    }

    public void setAllowedOrigins(List<String> allowedOrigins) {
        this.allowedOrigins = allowedOrigins;
    }
}
