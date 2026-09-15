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
- `POST /v1/outcome` — reports the fix that actually resolved an incident
- `GET /v1/metrics` — live accuracy, calibration and health KPIs

`/v1/recommend` returns a `decisionId`. Reporting the real outcome against it later is what turns
Recall from a system with opinions into one with a measured accuracy — see
[docs/MEASUREMENT.md](../docs/MEASUREMENT.md).

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
- BM25 retrieval, scaled against the query's own maximum achievable score so the result is an
  absolute "how much of the query did this document cover" ratio rather than a rank within the batch
- TF-IDF cosine similarity
- Structured signal overlap (error codes, DB/system, exception hints)
- Reciprocal-rank fusion across the independent lexical, BM25, cosine and signal rankings
- Context boosts (severity/system match, recency, feedback) — each applied only when the
  underlying field was actually supplied
- Confidence calibration and abstain when evidence is weak or ambiguous

The backend also returns similar incidents and debug features when requested.

### Abstain contract

`POST /v1/recommend` returns these fields whenever it declines to recommend:

| Field | Type | Meaning |
|---|---|---|
| `abstained` | boolean | No fix is being proposed |
| `abstainCode` | string | Stable reason code (below) |
| `abstainReason` | string | Human-readable explanation |
| `needsResolutionInput` | boolean | The caller should ask the engineer to record a fix |

| `abstainCode` | Triggered when |
|---|---|
| `empty_corpus` | No resolved tickets were supplied |
| `empty_query` | Query produced no usable tokens — `needsResolutionInput` is `false` here |
| `no_similar_incident` | Nothing cleared the similarity floor |
| `no_patch_evidence` | Similar incidents matched, but none carries a reusable fix |
| `weak_evidence` | Top candidate below the confidence or absolute score gate |
| `ambiguous_evidence` | Top two candidates are an effective tie |

`similarIncidents` stays populated while abstaining, so the engineer keeps the context even when
no fix is recommended.

### Scoring invariants

These are enforced by tests in `RecommenderScoringTest` and are easy to regress:

- A field the user never filled in must not influence ranking. An absent `severity` stays blank
  rather than defaulting to `medium`.
- An unknown or unparseable `changedDate` is treated as unknown, not as very old. Recency is a
  bounded tie-breaker (`0.92`–`1.08`), never a verdict.
- Additional tickets agreeing on the same fix must never *lower* confidence.
- A document sharing no signal with the query scores exactly zero.

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

See [docs/TESTING.md](../docs/TESTING.md) for the full strategy, including the accuracy backtest.

Included tests validate:

- Correct patch recommendation from similar incidents
- Abstain behaviour across every reason code, including an unrelated incident that shares only
  incidental vocabulary with the corpus
- The scoring invariants listed above
- The HTTP contract: abstain payload shape, request validation, and 503 (downstream unavailable)
  versus 500 (defect here) error mapping
- Robustness against malformed exports: null fields, ten malformed date formats, mixed
  encodings, 200KB text, duplicate ids, concurrent feedback
- Accuracy over a chronological replay (`BacktestTest`), gated on answer precision,
  hallucination rate and recall so a change cannot quietly degrade ranking
- Circuit-breaker open/close behavior
- Proxy failure fallback to local strategy

## Design Patterns Used

- **Strategy pattern**: `RecommendationGateway` interface with `LocalRecommendationGateway` and `ProxyRecommendationGateway`
- **Circuit Breaker pattern**: `LegacyCircuitBreaker` avoids repeated calls to unhealthy proxy backend
- **Controller Advice pattern**: centralized API exception handling via `ApiExceptionHandler`

## Configuration File

See:

- [src/main/resources/application.yml](src/main/resources/application.yml)
