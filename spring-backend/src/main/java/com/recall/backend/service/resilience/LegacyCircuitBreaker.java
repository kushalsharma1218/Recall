package com.recall.backend.service.resilience;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import com.recall.backend.config.BackendProperties;
import org.springframework.stereotype.Component;

@Component
public class LegacyCircuitBreaker {

    private final BackendProperties properties;
    private final AtomicInteger failures = new AtomicInteger(0);
    private final AtomicLong openUntilEpochMs = new AtomicLong(0);

    public LegacyCircuitBreaker(BackendProperties properties) {
        this.properties = properties;
    }

    public boolean allowRequest() {
        long now = System.currentTimeMillis();
        long openUntil = openUntilEpochMs.get();
        return openUntil <= 0 || now >= openUntil;
    }

    public void recordSuccess() {
        failures.set(0);
        openUntilEpochMs.set(0);
    }

    public void recordFailure() {
        int count = failures.incrementAndGet();
        if (count >= properties.getLegacyFailureThreshold()) {
            openUntilEpochMs.set(System.currentTimeMillis() + properties.getLegacyCooldownMs());
        }
    }

    public boolean isOpen() {
        return !allowRequest();
    }

    public int failureCount() {
        return failures.get();
    }

    public long remainingOpenMs() {
        long openUntil = openUntilEpochMs.get();
        if (openUntil <= 0) return 0;
        return Math.max(0, openUntil - System.currentTimeMillis());
    }

    public Map<String, Object> state() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("open", isOpen());
        out.put("failure_count", failureCount());
        out.put("remaining_open_ms", remainingOpenMs());
        out.put("failure_threshold", properties.getLegacyFailureThreshold());
        out.put("cooldown_ms", properties.getLegacyCooldownMs());
        return out;
    }
}
