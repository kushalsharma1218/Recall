package com.recall.backend.config;

import java.time.Duration;

import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;

@Configuration
public class RestClientConfig {

    @Bean
    public RestTemplate restTemplate(RestTemplateBuilder builder, BackendProperties properties) {
        // Connect uses the (shorter) health timeout: failing to establish a socket is the
        // signal the circuit breaker needs quickly, and health-timeout-ms was otherwise
        // documented in application.yml but never applied anywhere.
        return builder
            .setConnectTimeout(Duration.ofMillis(properties.getHealthTimeoutMs()))
            .setReadTimeout(Duration.ofMillis(properties.getRequestTimeoutMs()))
            .build();
    }
}
