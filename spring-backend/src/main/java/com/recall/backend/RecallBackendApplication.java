package com.recall.backend;

import com.recall.backend.config.BackendProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(BackendProperties.class)
public class RecallBackendApplication {
    public static void main(String[] args) {
        SpringApplication.run(RecallBackendApplication.class, args);
    }
}
