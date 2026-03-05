package com.recall.backend.service.resilience;

import com.recall.backend.config.BackendProperties;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LegacyCircuitBreakerTest {

    @Test
    void opensAfterThresholdAndClosesAfterSuccess() {
        BackendProperties properties = new BackendProperties();
        properties.setLegacyFailureThreshold(2);
        properties.setLegacyCooldownMs(30_000);

        LegacyCircuitBreaker breaker = new LegacyCircuitBreaker(properties);
        assertThat(breaker.allowRequest()).isTrue();

        breaker.recordFailure();
        assertThat(breaker.allowRequest()).isTrue();

        breaker.recordFailure();
        assertThat(breaker.isOpen()).isTrue();
        assertThat(breaker.allowRequest()).isFalse();
        assertThat(breaker.remainingOpenMs()).isGreaterThan(0);

        breaker.recordSuccess();
        assertThat(breaker.isOpen()).isFalse();
        assertThat(breaker.failureCount()).isZero();
        assertThat(breaker.allowRequest()).isTrue();
    }
}
