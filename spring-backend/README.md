# Recall Spring Backend (Strangler Migration)

This module is the **best-practice migration path** from the current Python FastAPI backend to Spring Boot without hurting recommendation quality.

## What this gives you

- Same API contract as today:
  - `GET /health`
  - `POST /v1/recommend`
  - `POST /v1/feedback`
  - `POST /v1/reload`
- `local` mode (default): Spring-only hybrid scorer (no Python runtime in request path).
- Optional `proxy` mode to forward to existing Python backend if you want side-by-side parity checks.

## Run

```bash
cd spring-backend
mvn spring-boot:run
```

Default URL: `http://127.0.0.1:8080`

In the frontend settings, point Backend URL to:

```text
http://127.0.0.1:8080
```

## Runtime modes

Configure in `application.yml`:

- `recall.backend.mode=local` (default, no Python required)
- `recall.backend.mode=proxy` (route to existing Python backend)

Legacy backend target (used only in `proxy` mode):

- `recall.backend.legacy-base-url=http://127.0.0.1:8000`

## Suggested cutover sequence

1. Run Spring backend on `8080` and point frontend to it.
2. Validate quality/latency metrics on your gold test set.
3. If needed, switch to `proxy` mode temporarily for parity comparison.
4. Keep API contract stable during migration.
5. Keep Python as optional benchmark reference, not a runtime dependency.
