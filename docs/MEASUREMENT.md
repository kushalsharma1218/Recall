# Measuring Recall on real traffic

Two different questions, two different machines:

| Question | Tool | Where |
|---|---|---|
| How good is the ranker on history we already have? | Backtest | [TESTING.md](TESTING.md), runs in CI |
| What is actually happening now, on real incidents? | Decision log + KPIs | `GET /v1/metrics` |

The backtest cannot answer the second. Production traffic is not the past, the corpus changes
under it, and the incidents people bring to a tool are not the incidents in an export. A system
can backtest beautifully and be useless in the room.

## The problem online measurement has to solve

In a backtest you know the right answer, because it already happened. In production, **at the
moment you answer, nobody knows whether you are right.** The label arrives hours or days later,
when the incident actually closes — if it arrives at all.

So the design is a join, not a counter:

```
POST /v1/recommend  ->  decision recorded, decisionId returned with the response
                          (what we said, how sure, how fast, corpus size)
          ... hours pass, the incident is actually resolved ...
POST /v1/outcome    ->  the real fix, joined back by decisionId
GET  /v1/metrics    ->  KPIs over decisions whose outcome is now known
```

Everything else follows from that shape. `decisionId` on the recommend response is not a
convenience — without it there is no way to ever learn whether the system was right.

## Where labels come from, best first

1. **The ticket system** — when the incident closes, what fix was actually recorded. Unbiased and
   free, but delayed. This is the one worth building (Stage 3 in the [roadmap](ROADMAP.md)).
2. **The engineer, explicitly** — "mark resolved with this patch". Fast and accurate, but only for
   incidents someone bothers to close in the tool. Wired today.
3. **Thumbs up/down** — cheap, high volume, and the weakest of the three: it records how someone
   felt about a suggestion, not what fixed the incident. Useful for ranking, not for accuracy.

## Three traps, and what the code does about them

### 1. Circularity — the one that quietly ruins everything

Recall suggests fix A. The engineer applies fix A *because Recall suggested it*. The ticket now
records fix A. Precision computed over that row is **100%, and it measures nothing** — it is our
own output echoed back to us.

Left alone, this makes a recommender look better the more people trust it, which is exactly
backwards.

So every outcome carries `suggestionAccepted`, and the KPIs report two numbers:

- `answerPrecision` — over all labels. Flattered by the above.
- **`independentPrecision`** — over labels where the engineer did *not* report applying our
  suggestion. Lower volume, far less circular. **This is the number to trust.**

When most labels are circular, the API says so in `caveats` and the dashboard prints it.

### 2. Abstention quality is unobservable in production

When the engine declines, we never find out what it would have said, so we cannot score it.
Live metrics can tell you *how often* it abstains and *why*; they cannot tell you whether those
abstentions were right.

That is a hard limit, not a gap to be filled with a proxy metric. The offline backtest is where
the abstain gate gets measured, because only there does the counterfactual exist. The KPI payload
states this outright rather than letting a dashboard imply coverage it does not have.

(The standard fix is a holdout: on a small sample, answer anyway and record what happened. Worth
doing eventually, and it is a deliberate product decision — you are choosing to show a
low-confidence answer during a real incident to learn something. Not a default.)

### 3. Small numbers that look like results

A precision of 100% over four labels is not a measurement. Every rate in the payload ships with
the denominator it was computed over, and `caveats` fires when:

- fewer than 30 answered decisions have known outcomes;
- outcomes are known for under half of decisions;
- most labels are circular;
- `independentPrecision` itself rests on a thin sample — the metric we tell people to trust is
  held to the same bar, otherwise the advice just moves the problem;
- abstentions are not producing recorded fixes.

The dashboard renders `caveats` verbatim, next to the numbers, not behind a tooltip.

## The KPIs

**Can we trust it**
- `independentPrecision` (+ `independentlyLabelled`) — headline. Of the fixes proposed and
  independently labelled, how many were right.
- `answerPrecision` (+ `answeredAndLabelled`) — same over all labels; read second.
- `calibration` — observed accuracy per stated-confidence band. When it says 80, is it right 80%
  of the time? A confidence number nobody has checked is decoration.

**Is it useful**
- `coverage` / `abstainRate` — how often it is willing to answer.
- `abstainsByCode` — *which* problem you have. Mostly `no_similar_incident` is a coverage problem,
  `ambiguous_evidence` a taxonomy problem, `weak_evidence` a retrieval problem. Three different
  projects, and this tells you which one you are in.
- `captureRate` — of abstentions, how many produced a recorded fix. **An abstain that teaches the
  system something is a success; one that teaches it nothing is a dead end.** This is the health
  metric for the capture loop, and it is a product metric, not a model metric.

**Is it healthy**
- `labelCoverage`, `medianTimeToLabelSeconds` — how much of reality you can see, and how stale it
  necessarily is.
- `latencyP50Ms` / `latencyP95Ms`, `medianCorpusSize`.

## Trying it before real data exists

```bash
cd spring-backend && mvn -B spring-boot:run
python3 tools/simulate_production.py --incidents 80
```

The simulator submits incidents, reports outcomes, and prints the live KPIs. Its mix is
deliberately unflattering: incidents the corpus can answer, incidents whose fix has never been
recorded, labels reached independently, and labels where the engineer just applied what we said.

**Its numbers mean nothing about real accuracy** — the corpus is tiny and the incident families
are lexically distinct, so the task is far easier than reality. It exists to prove the measurement
pipeline works end to end, not to produce a score.

Seeing it report 100% precision with a "most labels are circular" caveat attached is the simulator
working correctly.

## Current limits

The decision log is **in-memory and bounded** (10,000 records), so it resets on restart and
describes a rolling window rather than all-time history. That is stage-appropriate, not an
oversight: it makes the KPIs real today without requiring the database that Stage 3 introduces.
Nothing else depends on it staying in memory — moving it to Postgres makes the same KPIs durable
and long-range, and adds nothing to this design.
