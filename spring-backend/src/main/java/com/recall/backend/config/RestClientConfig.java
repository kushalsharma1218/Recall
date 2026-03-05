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
        return builder
            .setConnectTimeout(Duration.ofMillis(properties.getRequestTimeoutMs()))
            .setReadTimeout(Duration.ofMillis(properties.getRequestTimeoutMs()))
            .build();
    }
}
