package com.recall.backend.service;

import java.util.LinkedHashMap;

import com.recall.backend.config.BackendProperties;
import com.recall.backend.model.RecommendRequest;
import com.recall.backend.model.RecommendResponse;
import com.recall.backend.service.gateway.LocalRecommendationGateway;
import com.recall.backend.service.gateway.ProxyRecommendationGateway;
import com.recall.backend.service.resilience.LegacyCircuitBreaker;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

class RecommenderServiceTest {

    @Test
    void fallsBackToLocalWhenProxyFails() {
        BackendProperties properties = new BackendProperties();
        properties.setMode(BackendProperties.Mode.PROXY);
        properties.setFallbackEnabled(true);
        properties.setLegacyFailureThreshold(5);
        properties.setLegacyCooldownMs(30_000);

        ProxyRecommendationGateway proxy = Mockito.mock(ProxyRecommendationGateway.class);
        LocalRecommendationGateway local = Mockito.mock(LocalRecommendationGateway.class);
        LegacyCircuitBreaker breaker = new LegacyCircuitBreaker(properties);

        RecommendResponse localResp = new RecommendResponse();
        localResp.engine = "spring-local-hybrid";
        localResp.debug = new LinkedHashMap<>();

        when(proxy.recommend(any())).thenThrow(new RuntimeException("proxy down"));
        when(local.recommend(any())).thenReturn(localResp);

        RecommenderService service = new RecommenderService(properties, proxy, local, breaker);
        RecommendResponse response = service.recommend(new RecommendRequest());

        assertThat(response.engine).isEqualTo("spring-local-hybrid");
        assertThat(response.debug.get("bridge_fallback")).isEqualTo(true);
        assertThat(response.debug.get("bridge_error")).isEqualTo("legacy_unavailable");
    }

    @Test
    void throwsWhenCircuitIsOpenAndFallbackDisabled() {
        BackendProperties properties = new BackendProperties();
        properties.setMode(BackendProperties.Mode.PROXY);
        properties.setFallbackEnabled(false);
        properties.setLegacyFailureThreshold(1);
        properties.setLegacyCooldownMs(60_000);

        ProxyRecommendationGateway proxy = Mockito.mock(ProxyRecommendationGateway.class);
        LocalRecommendationGateway local = Mockito.mock(LocalRecommendationGateway.class);
        LegacyCircuitBreaker breaker = new LegacyCircuitBreaker(properties);
        breaker.recordFailure(); // opens immediately because threshold=1

        RecommenderService service = new RecommenderService(properties, proxy, local, breaker);

        assertThatThrownBy(() -> service.recommend(new RecommendRequest()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("circuit open");
    }
}
