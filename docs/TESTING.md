# Testing Recall

Run everything with one command:

```bash
./tools/run-all-tests.sh
```

It runs the backend suites, starts the services if needed, and drives the UI in a browser.

## Why four layers

A recommender fails in a way ordinary software does not: it keeps working, and quietly gets worse.
No individual test fails, no exception is thrown, and nobody notices until an engineer stops
trusting it. So the layers below are ordered by what they can catch, not by how fast they run.

| Layer | Where | Catches |
|---|---|---|
| 1. Invariants | `RecommenderScoringTest` | A field the user never filled in changing the ranking |
| 2. Robustness | `RecommenderRobustnessTest` | A malformed export throwing a 500 mid-incident |
| 3. Contract | `RecommenderControllerTest` | The abstain payload silently changing shape |
| 4. Accuracy | `BacktestTest` | A change that fixes one case and degrades twenty |
| 5. Journeys | `frontend/e2e` | A correct decision being discarded on its way to the screen |

Layer 4 is the one most projects skip, and it is the only layer that can catch a *gradual*
regression. Layer 5 exists because the most damaging bug found so far lived entirely in the
frontend: the backend abstained correctly and the UI threw the answer away.

## Layer 1 — Scoring invariants

Properties that must hold regardless of data. Each was a real bug:

- A field the user never supplied must not influence ranking. An absent `severity` stays blank
  instead of defaulting to `medium`.
- An unknown or unparseable `changedDate` means unknown, not "very old". Recency is a bounded
  tie-breaker (`0.92`–`1.08`), never a verdict.
- Additional tickets agreeing on the same fix must never *lower* confidence.
- A document sharing no signal with the query scores exactly zero.

**These tests are mutation-checked.** Each fix was verified by reintroducing the bug and confirming
the matching test fails. A test that has never failed has not been shown to work — the first pass
here caught only four of five mutations, because the headline test used a corpus where both the
old and new code scored zero and so discriminated nothing.

## Layer 2 — Robustness

Real Azure exports contain half-filled work items, text pasted out of terminals, mixed encodings
and nulls. Covered: null queries, null corpus entries, ten malformed date formats, tags as a list
/ delimited string / number / null, emoji and CJK and RTL text, markup in ticket text, 200 KB
fields, duplicate ticket ids, stopword-only queries, `top_k` boundaries, and concurrent feedback.

The rule throughout: **degrade to an abstain, never to an exception.** A 500 during an incident is
worse than "I don't know".

Two of these print timings, because they are also the standing argument about scale:

```
[perf] 200KB single ticket scored in   277 ms
[perf] 5000-ticket corpus scored in   1012 ms
```

A 5,000-ticket corpus is larger than a real on-call rotation accumulates in years, and it scores in
about a second — so throughput is not the problem. But that whole pass runs *per request* today,
because the corpus is uploaded with every query. That second is the argument for indexing on
ingestion, not for more machines.

## Layer 4 — The backtest

The interesting one. `BacktestRunner` replays a dataset of resolved incidents in chronological
order; for each incident the engine may only see incidents that closed **strictly before** it.

That constraint is the whole point. Scoring against a corpus that already contains the answer
measures memory, not forecasting, and will report excellent numbers for a system that is useless
in production.

### The outcome taxonomy

Ordinary accuracy hides the distinction that matters here, so every replayed incident lands in one
of five buckets:

| Outcome | Meaning |
|---|---|
| `CORRECT` | Recommended the fix that was actually applied |
| `WRONG_ANSWER` | Recommended a fix; the right one existed but was not chosen |
| `HALLUCINATED` | Recommended a fix for an incident whose real fix had **never been seen** |
| `MISSED_ANSWER` | Abstained although a prior incident used the same fix |
| `CORRECT_ABSTAIN` | Abstained on a genuinely unprecedented incident |

`MISSED_ANSWER` costs the user time. `WRONG_ANSWER` and `HALLUCINATED` cost them trust, and are
spent during an outage when attention is scarcest. Treating those as the same kind of error is how
a recommender ends up optimised for the wrong thing.

### Metrics, in priority order

1. **Answer precision** — of the fixes proposed, how many were right. The headline. A wrong fix
   mid-incident costs more than no fix, so this is defended ahead of coverage and recall.
2. **Hallucination rate** — answering on an unprecedented incident. Target zero.
3. **Answerable recall** — of the incidents a prior fix could have solved, how many we solved.
   Guards against buying precision with silence.
4. Recall@3, MRR — ranking quality.
5. **Calibration** — observed accuracy per stated-confidence band. A confidence number nobody has
   checked is decoration.

The report also breaks down **why** it abstained, which tells you which problem you actually have:
mostly `no_similar_incident` is a coverage problem, `ambiguous_evidence` a taxonomy problem,
`weak_evidence` a retrieval problem. Those are three different projects.

### Using your own data

```bash
mvn -B test -Dtest=BacktestTest -Drecall.backtest.dataset=/path/to/incidents.json
```

The bundled dataset is synthetic and its absolute numbers mean nothing — it exists to keep the
harness honest and the gate stable. **Do not commit real incident data.** Regenerate the sample
with `python3 tools/generate_backtest_fixture.py`.

### The gates are a ratchet

Thresholds sit at the observed baseline, not at aspirational values. Raise them as the engine
improves; treat a failure as "explain the regression", never as "lower the bar".

`hallucinationRateDoesNotRegress` is deliberately gated at the current baseline rather than at its
target of zero, so the number stays visible instead of being skipped. The residual failures are
structural: where the corpus is **unanimous but incomplete** — every past incident with these
symptoms used fix A, and this one needed fix B that nobody has recorded yet — no lexical signal
distinguishes them and no threshold recovers it. Closing that needs evidence the text does not
carry (the code diff, the root cause) or a reasoning step that can argue the negative case.

### What the harness caught immediately

On its first run it surfaced a calibration inversion: the `80-89` confidence band scored **0%**
observed accuracy while the `50-69` bands scored 100%. The engine was most confident exactly where
it was wrong.

It then prevented a bad fix. A "contradiction penalty" — cutting confidence when past incidents
with the same symptoms were resolved differently — is a sound-sounding idea that collapsed recall
from 73.5% to 32.4% when applied linearly, and did nothing at all when applied sharply. It was
reverted rather than tuned until the numbers looked good, because tuning a ranker against a
synthetic fixture is fitting to noise. **That is what the harness is for.** Re-test the hypothesis
when real data exists.

## Layer 5 — Journeys

See [frontend/e2e/README.md](../frontend/e2e/README.md). Four journeys in a real browser against a
real backend. Two of them together pin the distinction the product depends on: an **abstain is an
answer** and must stop the engine cascade, while a **transport failure is not** and may fall
through to the local engine.

These are mutation-checked too — reverting the frontend abstain fix makes the journey fail.

## Adding a test

- Changed scoring? Add to layer 1, then **reintroduce the bug** and confirm your test fails.
- Changed the API? Add to layer 3.
- Think accuracy improved? Run layer 4 and show the numbers. An improvement that cannot be
  measured is a hypothesis, not an improvement.
