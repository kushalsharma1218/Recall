#!/usr/bin/env python3
"""
Drives realistic traffic through a running Recall backend and prints the live KPIs.

This is not a test — it proves the *measurement pipeline* works end to end before real incidents
exist. It submits incidents, then reports the fix that actually resolved each one, exactly as a
production integration would, and reads back the KPIs the decisions produced.

The mix is deliberately unflattering:
  - incidents the corpus can answer
  - incidents whose real fix has never been recorded  -> the engine should decline
  - outcomes the engineer reached independently       -> honest labels
  - outcomes where the engineer applied our suggestion -> circular labels

That last pair is the point. A simulator that only reports labels agreeing with us would show a
precision of 1.00 and mean nothing.

Usage:
  python3 tools/simulate_production.py [--backend http://127.0.0.1:8080] [--incidents 60]
"""
import argparse
import json
import random
import sys
import urllib.error
import urllib.request

FAMILIES = {
    "patch_deadlock_retry": [
        ("Deadlock on checkout order writes", "Transaction chosen as deadlock victim, error 1205, concurrent order inserts"),
        ("Order service failing with 1205", "Repeated deadlock victim errors under concurrent writes to the orders table"),
        ("Checkout transactions rolling back", "Lock contention between the order writer and inventory updater, victim 1205"),
    ],
    "patch_add_covering_index": [
        ("Reporting query timing out", "Full table scan on a 40M row table, no usable index for the predicate"),
        ("Dashboard load takes 90 seconds", "Execution plan shows a clustered index scan instead of a seek"),
        ("Slow customer lookup endpoint", "Query filters on a column with no supporting index, scanning the whole table"),
    ],
    "patch_pool_sizing": [
        ("Connection pool exhausted at peak", "Requests queue waiting for a free connection, timeouts after 30 seconds"),
        ("Timeouts obtaining a connection", "The pool reached its maximum size and callers block until one is released"),
        ("API returns 500s during traffic spike", "No free connections available, pool saturated by long-running requests"),
    ],
    "patch_rotate_credentials": [
        ("Login failures from the reporting host", "Login failed for user, error 18456, after the credential rotation window"),
        ("Service account cannot connect", "Authentication rejected with error 18456 state 8, password mismatch"),
    ],
}

# Fixes nobody has recorded. The engine must decline on these.
NOVEL = [
    ("patch_dns_failover", "Regional endpoint unreachable after failover",
     "Client SDK keeps resolving the old write region following an account failover"),
    ("patch_tls_cipher", "Clients rejected during TLS handshake",
     "Handshake fails after the minimum TLS version was raised on the server"),
    ("patch_collation_mismatch", "Join fails with a collation conflict",
     "Cannot resolve the collation conflict between two columns in an equality operation"),
]


def post(url, payload):
    req = urllib.request.Request(
        url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def get(url):
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def pct(value):
    return f"{value * 100:5.1f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://127.0.0.1:8080")
    ap.add_argument("--incidents", type=int, default=60)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed)

    try:
        get(f"{args.backend}/health")
    except (urllib.error.URLError, OSError) as exc:
        sys.exit(f"Backend not reachable at {args.backend}: {exc}\n"
                 f"Start it with: cd spring-backend && mvn -B spring-boot:run")

    corpus = []
    patches = []
    for patch_id, phrasings in FAMILIES.items():
        patches.append({"id": patch_id, "name": patch_id})
        for i, (title, desc) in enumerate(phrasings):
            corpus.append({
                "id": f"SEED-{patch_id}-{i}", "title": title, "description": desc,
                "resolvedPatch": patch_id, "resolutionDescription": f"Applied {patch_id}",
                "severity": "high", "system": "Azure SQL Database",
                "changedDate": "2025-06-01T09:00:00Z", "source": "azure-devops",
            })

    known = [(p, t, d) for p, phr in FAMILIES.items() for t, d in phr]
    submitted = declined = labelled = 0

    for n in range(args.incidents):
        # One incident in four has a fix nobody has recorded yet.
        if random.random() < 0.25:
            true_patch, title, desc = random.choice(NOVEL)
            novel = True
        else:
            true_patch, title, desc = random.choice(known)
            title = title + random.choice(["", " in production", " during peak"])
            novel = False

        result = post(f"{args.backend}/v1/recommend", {
            "query": {"title": title, "description": desc, "severity": "high",
                      "system": "Azure SQL Database"},
            "patches": patches, "local_corpus": corpus, "top_k": 5,
        })
        submitted += 1
        decision_id = result.get("decisionId")
        if result.get("abstained"):
            declined += 1

        # The label arrives when the incident really closes. Not every incident gets one —
        # that is realistic, and the KPI report says so via labelCoverage.
        if random.random() < 0.75:
            suggested = (result.get("recommendations") or [{}])[0].get("patchId")
            # If we suggested the right thing, the engineer sometimes just applies it. That
            # makes the label circular, and the flag is what lets the KPIs discount it.
            accepted = bool(suggested) and suggested == true_patch and random.random() < 0.6
            post(f"{args.backend}/v1/outcome", {
                "decisionId": decision_id,
                "appliedPatchId": true_patch,
                "suggestionAccepted": accepted,
                "source": "engineer" if accepted else "ticket-system",
            })
            labelled += 1

        # An abstain the engineer acts on grows the corpus — the capture loop.
        if novel and result.get("needsResolutionInput") and random.random() < 0.5:
            corpus.append({
                "id": f"NEW-{n}", "title": title, "description": desc,
                "resolvedPatch": true_patch, "resolutionDescription": f"Applied {true_patch}",
                "severity": "high", "system": "Azure SQL Database",
                "changedDate": "2025-09-01T09:00:00Z", "source": "azure-devops",
            })
            if not any(p["id"] == true_patch for p in patches):
                patches.append({"id": true_patch, "name": true_patch})

    print(f"\nsubmitted {submitted} incidents, {declined} declined, {labelled} labelled, "
          f"corpus grew to {len(corpus)}\n")

    k = get(f"{args.backend}/v1/metrics")

    print("=== Recall live KPIs ========================================")
    print(f"  decisions             {k['decisions']:6d}")
    print(f"  labelled              {k['labelledDecisions']:6d}   coverage {pct(k['labelCoverage'])}")
    print()
    print("  CAN WE TRUST IT")
    print(f"    answer precision    {pct(k['answerPrecision'])}   (n={k['answeredAndLabelled']})")
    print(f"    independent         {pct(k['independentPrecision'])}   (n={k['independentlyLabelled']})  <- trust this one")
    print()
    print("  IS IT USEFUL")
    print(f"    coverage            {pct(k['coverage'])}")
    print(f"    abstain rate        {pct(k['abstainRate'])}")
    print(f"    capture rate        {pct(k['captureRate'])}   ({k['missedAnswers']} abstentions yielded a fix)")
    for code, count in (k.get("abstainsByCode") or {}).items():
        print(f"      {code:<22}{count:4d}")
    print()
    if k.get("calibration"):
        print("  IS IT CALIBRATED")
        for band, (accuracy, count) in sorted(k["calibration"].items()):
            print(f"    {band}  observed {pct(accuracy)}  (n={int(count)})")
        print()
    print("  IS IT HEALTHY")
    print(f"    latency p50/p95     {k['latencyP50Ms']} ms / {k['latencyP95Ms']} ms")
    print(f"    median corpus       {k['medianCorpusSize']}")
    if k.get("caveats"):
        print()
        print("  READ THIS BEFORE QUOTING ANY NUMBER ABOVE")
        for c in k["caveats"]:
            print(f"    - {c}")
    print("=============================================================\n")


if __name__ == "__main__":
    main()
