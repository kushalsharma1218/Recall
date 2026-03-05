# Recall Spring Backend

This is the active Java backend for Recall. It serves recommendation APIs used by the frontend and supports local hybrid scoring with confidence-aware abstain behavior.

## Purpose

- Provide a stable backend API for Recall UI
- Score and rank patch recommendations from resolved incident corpus
- Return explainable similar incidents and reasoning
- Support feedback ingestion for ranking improvements

## API Contract

- `GET /health`
- `POST /v1/recommend`
- `POST /v1/feedback`
- `POST /v1/reload`

### Health example

```bash
curl http://127.0.0.1:8080/health
```

### Recommend example

```bash
curl -X POST http://127.0.0.1:8080/v1/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "title": "SQL deadlock in checkout",
      "description": "Error 1205 under high write traffic",
      "severity": "high",
      "system": "SQL Server"
    },
    "patches": [
      { "id": "patch_deadlock", "name": "Deadlock Retry" }
    ],
    "local_corpus": [],
    "top_k": 5,
    "debug": true
  }'
```

## Recommendation Logic (Local Mode)

`LocalFallbackRecommender` applies:

- Tokenization and weighted lexical representation
- BM25-style retrieval signal
- TF-IDF cosine similarity
- Structured signal overlap (error codes, DB/system, exception hints)
- Context boosts (severity/system match, recency, feedback)
- Confidence calibration and abstain when evidence is weak/ambiguous

The backend also returns similar incidents and debug features when requested.

## Runtime Modes

Configured via `application.yml` (`recall.backend`):

- `mode: local` (default and recommended)
- `mode: proxy` (legacy bridge mode; optional compatibility path)
- `fallback-enabled: true`
- `legacy-failure-threshold` and `legacy-cooldown-ms` for circuit-breaker behavior

Default port:

- `8080`

## Run

```bash
cd spring-backend
mvn spring-boot:run
```

Then point frontend backend URL to:

```text
http://127.0.0.1:8080
```

## Test

```bash
cd spring-backend
mvn test
```

Included tests validate:

- Correct patch recommendation from similar incidents
- Proper abstain behavior when no valid mapped evidence exists
- Circuit-breaker open/close behavior
- Proxy failure fallback to local strategy

## Design Patterns Used

- **Strategy pattern**: `RecommendationGateway` interface with `LocalRecommendationGateway` and `ProxyRecommendationGateway`
- **Circuit Breaker pattern**: `LegacyCircuitBreaker` avoids repeated calls to unhealthy proxy backend
- **Controller Advice pattern**: centralized API exception handling via `ApiExceptionHandler`

## Configuration File

See:

- [src/main/resources/application.yml](src/main/resources/application.yml)
