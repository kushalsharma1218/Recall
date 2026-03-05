package com.recall.backend.config;

import java.util.List;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CorsConfig {

    private final BackendProperties backendProperties;

    public CorsConfig(BackendProperties backendProperties) {
        this.backendProperties = backendProperties;
    }

    @Bean
    public WebMvcConfigurer webMvcConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                List<String> configuredOrigins = backendProperties.getAllowedOrigins();
                String[] origins = (configuredOrigins == null || configuredOrigins.isEmpty())
                    ? new String[]{"http://localhost:*", "http://127.0.0.1:*"}
                    : configuredOrigins.toArray(new String[0]);
                registry.addMapping("/**")
                    .allowedOriginPatterns(origins)
                    .allowedMethods("GET", "POST", "OPTIONS")
                    .allowedHeaders("Content-Type", "Authorization")
                    .allowCredentials(false);
            }
        };
    }
}
