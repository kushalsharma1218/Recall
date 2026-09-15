# End-to-end journeys

Drives the real UI in a real browser against a real backend. The unit and backtest layers prove
the engine *decides* correctly; this layer proves the decision survives the trip to the screen —
which is exactly where the abstain used to be thrown away.

## What it covers

| Journey | Asserts |
|---|---|
| Corpus has an answer | A fix is recommended, and the engineer is not asked to supply one |
| Corpus has no answer | **No** fix is shown, the "Record the fix" prompt appears, and it opens the training tab |
| Backend unreachable | Falls back to the local engine and labels it honestly |
| Hostile ticket text | Markup renders as text — no execution, no injected elements |
| Measurement loop | A decision reaches the log, resolving reports an outcome, the dashboard shows the KPIs **and their caveats** |

The second and third rows together pin the distinction the product depends on: an **abstain is an
answer** and must stop the engine cascade, while a **transport failure is not** and may fall through.

## Run

```bash
# terminal 1
cd spring-backend && mvn -B spring-boot:run

# terminal 2
cd frontend && python3 -m http.server 4173

# terminal 3
cd frontend/e2e && npm install && npm test
```

Override targets with `RECALL_APP_URL` and `RECALL_BACKEND_URL`.

Uses the pre-installed Chromium at `/opt/pw-browsers/chromium`. On a machine without it, drop the
`executablePath` from `chromium.launch()` and run `npx playwright install chromium`.

## Note on state

Each journey clears `localStorage`/`sessionStorage` and re-seeds through the app's own
`TicketIntegrations` / `TrainingStore` APIs rather than writing storage keys directly, so the setup
path is itself exercised and the tests do not silently rot when the storage format changes.
