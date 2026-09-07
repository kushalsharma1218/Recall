package com.recall.backend.controller;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(
        MethodArgumentNotValidException ex,
        HttpServletRequest request
    ) {
        String message = ex.getBindingResult()
            .getFieldErrors()
            .stream()
            .map(this::formatFieldError)
            .collect(Collectors.joining("; "));

        if (message.isBlank()) {
            message = "Invalid request payload";
        }

        return error(HttpStatus.BAD_REQUEST, "validation_failed", message, request.getRequestURI());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleBadRequest(IllegalArgumentException ex, HttpServletRequest request) {
        return error(HttpStatus.BAD_REQUEST, "bad_request", ex.getMessage(), request.getRequestURI());
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<Map<String, Object>> handleUnavailable(IllegalStateException ex, HttpServletRequest request) {
        return error(HttpStatus.SERVICE_UNAVAILABLE, "service_unavailable", ex.getMessage(), request.getRequestURI());
    }

    /**
     * Anything not classified above is a defect in this service, not a downstream outage.
     * Reporting it as 503 told clients to retry a request that will fail identically, and
     * echoing {@code ex.getMessage()} leaked internal detail to the browser.
     */
    @ExceptionHandler(RuntimeException.class)
    public ResponseEntity<Map<String, Object>> handleRuntime(RuntimeException ex, HttpServletRequest request) {
        log.error("Unhandled error on {} {}", request.getMethod(), request.getRequestURI(), ex);
        return error(
            HttpStatus.INTERNAL_SERVER_ERROR,
            "internal_error",
            "Unexpected backend error",
            request.getRequestURI()
        );
    }

    private ResponseEntity<Map<String, Object>> error(
        HttpStatus status,
        String code,
        String message,
        String path
    ) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("timestamp", Instant.now().toString());
        body.put("status", status.value());
        body.put("error", code);
        body.put("message", message == null ? "" : message);
        body.put("path", path == null ? "" : path);
        return ResponseEntity.status(status).body(body);
    }

    private String formatFieldError(FieldError e) {
        return e.getField() + ": " + (e.getDefaultMessage() == null ? "invalid value" : e.getDefaultMessage());
    }
}
