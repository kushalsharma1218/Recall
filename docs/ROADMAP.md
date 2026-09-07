# Recall Roadmap

Written after the first correctness pass. The ordering is deliberate: each stage is only worth
starting once the one above it holds.

## Where Recall is today

- The corpus lives in the browser (`localStorage`) and is uploaded on every `/v1/recommend` call
  as `local_corpus`.
- Azure DevOps is called directly from the browser with a PAT held in memory only.
- Scoring is implemented twice: `frontend/js/app.js` (`PatchRecommender`) and
  `spring-backend/.../LocalFallbackRecommender.java`.
- There is no scheduled ingestion. "Periodically fetch resolved tickets" is manual today.

Each of those is fine for a demo and blocking for production. They are the backlog below.

---

## Stage 1 — Correctness (done)

Fixed in the pass that introduced `RecommenderScoringTest`:

- BM25 was normalised against the best row in the same request, so the least-bad candidate always
  scored a perfect 1.0. Every absolute abstain threshold was therefore dead, and the engine would
  confidently recommend a SQL deadlock fix for a Kubernetes incident that merely shared the words
  "restart" and "load". BM25 is now scaled against the query's own maximum achievable score.
- `severity` defaulted to `medium` on both the query and the corpus model, so every request scored
  agreement on a field nobody filled in. Absent severity now stays absent.
- Recency was unbounded below and treated an unknown timestamp as ten years old — a 42% score
  penalty for missing metadata. It is now a bounded tie-breaker and unknown means unknown.
- Reciprocal-rank fusion was fusing one ranked list with itself, handing rank credit to documents
  that matched nothing. It now fuses the independent lexical, BM25, cosine and signal rankings.
- Confidence was the mean similarity across supporting tickets, so extra tickets agreeing on the
  same fix *lowered* confidence. It now leans on the best evidence.
- An abstain was reported to the frontend as a failure, which cascaded to the local engine and
  guessed anyway. An abstain is now an authoritative answer that stops the cascade.

## Stage 2 — Make accuracy measurable

Nothing below this line is worth tuning until regressions are visible.

1. **A golden set in the repo.** 100–200 resolved incidents with the fix that was actually applied,
   as a fixture. Hold out 20%.
2. **A metrics harness in CI** reporting Top-1, Recall@3, MRR — and separately, on the abstain
   decision: precision (of the fixes we *did* recommend, how many were right) and abstain rate.
   Fail the build when Top-1 or abstain precision regresses.
3. **Precision is the metric that matters, not recall.** A wrong fix during an incident costs more
   than no fix. Target abstain precision ≥ 0.9 and accept a high abstain rate early on; the
   thresholds in `LocalFallbackRecommender` (`MIN_TOP_CONFIDENCE`, `MIN_TOP_SCORE`, `TIE_MARGIN`)
   are the dials, and they should be *fitted to the golden set*, not guessed.
4. **Log every abstain with its code.** The distribution tells you what to build next: mostly
   `no_similar_incident` means an ingestion/coverage problem, mostly `ambiguous_evidence` means a
   patch-taxonomy problem, mostly `weak_evidence` means a retrieval problem. These are very
   different projects and the counter tells you which one you have.

## Stage 3 — Server-side ingestion

The current design cannot do the thing the product is for: fetch resolved tickets *periodically*.
A browser tab that must be open, with a PAT that is deliberately not persisted, cannot run a
schedule.

1. Move the Azure DevOps client into the backend. Store the PAT server-side in a secret manager,
   never in the browser.
2. A scheduled job (`@Scheduled`, or an external trigger) pulls resolved work items on a watermark
   (`System.ChangedDate > last_sync`), not a full re-scan.
3. Persist tickets in Postgres. Drop `local_corpus` from the request body — the server owns the
   corpus. This is the single highest-leverage change in this document: it removes the per-request
   re-tokenisation and re-IDF of the entire corpus, which is currently O(corpus) per query.
4. Keep the API shape. The abstain contract does not change.

## Stage 4 — Retrieval quality

Only after Stage 2 can these be judged rather than believed.

1. **Embeddings alongside BM25.** Lexical matching fails on vocabulary mismatch ("connection pool
   exhausted" vs "no free connections"). Add a vector index (pgvector) and fuse with BM25 via the
   RRF that is now real. Expect the biggest single accuracy gain here.
2. **Index once, not per request.** Precompute IDF and document vectors on ingestion.
3. **Use the code diff.** `azure.js` already fetches PR changes. Files touched by the fix are a
   strong signal and are currently collected but not scored.
4. **Learn the thresholds.** Once there is a labelled set, fit the abstain gate rather than
   hand-tuning constants.

## Stage 5 — Scale and the repo question

> "currently frontend and backend is in one repo… how to solve this at scale"

One repo is not the problem, and splitting it now would cost more than it returns. A single repo
with clear internal boundaries (`frontend/`, `spring-backend/`) keeps the API contract changeable
in one commit — worth a lot while the contract is still moving. Split when teams, not directories,
start colliding.

What actually needs to change for production scale, in order:

1. **Authentication and tenancy.** There is none today. Multi-tenant means a `tenant_id` on every
   ticket row and on every query, enforced in the data layer.
2. **Secrets off the client.** Covered by Stage 3.
3. **Persistence for feedback.** Votes currently live in a bounded in-memory map and vanish on
   restart.
4. **Observability.** Structured logs, request tracing, and the abstain-code counter from Stage 2.
5. **Then** consider extracting the recommender into its own service — when the retrieval path
   needs to scale independently of the API, which is a real signal and not yet present.
