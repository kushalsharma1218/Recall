#!/usr/bin/env python3
"""
Generates the synthetic backtest fixture used by BacktestTest.

Deterministic (fixed seed) so the CI gate is stable. Each fix family has several
genuinely different phrasings — templated text would make retrieval look far better
than it is. Run: python3 tools/generate_backtest_fixture.py
"""
import json, random, datetime, pathlib

random.seed(20260907)
START = datetime.datetime(2025, 1, 6, 9, 0, 0)

# family -> (fix id, system, severity, [ (title, description) phrasings ])
FAMILIES = {
    "deadlock": ("patch_deadlock_retry", "SQL Server 2019", "high", [
        ("Deadlock on checkout order writes", "Transaction chosen as deadlock victim, error 1205, during concurrent order inserts"),
        ("Order service failing with 1205", "Repeated deadlock victim errors under concurrent writes to the orders table"),
        ("Checkout transactions rolling back", "Lock contention between the order writer and the inventory updater, victim error 1205"),
        ("Intermittent write failures in billing", "Two transactions taking locks in opposite order, deadlock detected and one rolled back"),
        ("Deadlock between invoice and ledger writers", "Error 1205 raised, deadlock graph shows opposite lock ordering on two tables"),
        ("Concurrent updates aborting", "Victim process killed by the deadlock monitor during peak write traffic"),
    ]),
    "missing_index": ("patch_add_covering_index", "Azure SQL Database", "medium", [
        ("Reporting query timing out", "Full table scan on a 40M row table, no usable index for the predicate"),
        ("Dashboard load takes 90 seconds", "Execution plan shows a clustered index scan instead of a seek"),
        ("Slow customer lookup endpoint", "Query filters on a column with no supporting index, scanning the whole table"),
        ("Nightly export overruns its window", "Plan regression to a scan after the table grew past 30M rows"),
        ("Search page latency spike", "Predicate is not sargable against any existing index, resulting in a scan"),
        ("Analytics job exceeds runtime budget", "Missing index warning in the plan, estimated 92 percent improvement"),
    ]),
    "conn_pool": ("patch_pool_sizing", "Azure SQL Database", "high", [
        ("Connection pool exhausted at peak", "Requests queue waiting for a free connection, timeouts after 30 seconds"),
        ("Timeouts obtaining a connection", "The pool reached its maximum size and callers block until one is released"),
        ("API returns 500s during traffic spike", "No free connections available, pool saturated by long-running requests"),
        ("Service degrades under load", "Connections not returned promptly, pool starved and new requests time out"),
        ("Intermittent connection acquisition failures", "Pool max size reached, waiters exceed the configured timeout"),
        ("Checkout stalls when traffic doubles", "All pooled connections busy, request queue grows without bound"),
    ]),
    "login": ("patch_rotate_credentials", "Azure SQL Managed Instance", "critical", [
        ("Login failures from the reporting host", "Login failed for user, error 18456, after the credential rotation window"),
        ("Service account cannot connect", "Authentication rejected with error 18456 state 8, password mismatch"),
        ("Batch jobs failing to authenticate", "Cannot connect to the instance, login failed for the batch service principal"),
        ("ETL cannot reach the database", "Error 18456 returned for the ETL account since the last secret rotation"),
        ("Auth errors after secret rotation", "Login failed for user, the stored credential no longer matches"),
    ]),
    "replica_lag": ("patch_replica_redo_tuning", "SQL Server 2019 Always On", "high", [
        ("Secondary replica falling behind", "Redo queue growing steadily, replica is 30 minutes behind the primary"),
        ("Availability group out of sync", "Synchronization failure, redo thread cannot keep up with the log volume"),
        ("Readable secondary serving stale data", "Redo queue backlog means reads on the secondary lag the primary"),
        ("AG health warning on the secondary", "Replica sync failure with a large and growing redo queue"),
        ("Failover would lose recent commits", "Secondary replica redo lag exceeds the recovery objective"),
    ]),
    "tempdb": ("patch_tempdb_files", "SQL Server 2022", "medium", [
        ("Waits on tempdb allocation pages", "PFS and GAM page contention in tempdb under concurrent temp table creation"),
        ("Throughput collapses with many sessions", "Allocation bitmap contention in tempdb, sessions waiting on PAGELATCH"),
        ("Batch throughput drops at concurrency", "tempdb metadata contention across a single data file"),
        ("Latch waits during heavy reporting", "Contention on tempdb allocation structures with only one data file configured"),
    ]),
    "throttle": ("patch_scale_service_tier", "Azure SQL Serverless", "medium", [
        ("Requests rejected with 429", "Too many requests returned once the DTU limit is reached during peak hours"),
        ("Throttling during the morning peak", "Service tier limit hit, requests throttled and clients retry"),
        ("Rate limit errors from the data tier", "429 responses once compute utilisation saturates the provisioned tier"),
        ("Workload capped at the tier ceiling", "Throttling kicks in as the workload exceeds the purchased capacity"),
    ]),
    "corruption": ("patch_restore_pages", "SQL Server on Azure VM", "critical", [
        ("Suspect pages detected on a data file", "Error 824 logical consistency error reported during a read"),
        ("Consistency check reports corruption", "DBCC CHECKDB found allocation errors, error 823 in the log"),
        ("IO errors reading a data page", "Error 823 raised, the page failed its checksum validation"),
        ("Database flagged as suspect", "Corruption detected on read, suspect pages table has new entries"),
    ]),
}

# Two families with near-identical symptoms but different fixes — should trip the
# ambiguity gate rather than produce a confident coin flip.
AMBIGUOUS = {
    "cpu_a": ("patch_query_rewrite", "Azure SQL Database", "high", [
        ("Sustained high CPU on the primary", "CPU pinned at 100 percent during business hours, plan cache churn"),
        ("CPU saturation during business hours", "Processor time sustained near 100 percent, workload cannot keep up"),
    ]),
    "cpu_b": ("patch_scale_up_vcore", "Azure SQL Database", "high", [
        ("Sustained high CPU on the primary", "CPU pinned at 100 percent during business hours, plan cache churn"),
        ("CPU saturation during business hours", "Processor time sustained near 100 percent, workload cannot keep up"),
    ]),
}

# Incidents whose fix is never seen beforehand. The engine MUST abstain on these.
NOVEL = [
    ("patch_dns_failover", "Azure Cosmos DB", "critical",
     "Regional endpoint unreachable after failover",
     "Client SDK keeps resolving the old write region following an account failover"),
    ("patch_tls_cipher", "Azure Database for PostgreSQL", "high",
     "Clients rejected during TLS handshake",
     "Handshake fails after the minimum TLS version was raised on the server"),
    ("patch_collation_mismatch", "Azure SQL Database", "medium",
     "Join fails with a collation conflict",
     "Cannot resolve the collation conflict between two columns in an equality operation"),
    ("patch_partition_switch", "SQL Server 2022", "medium",
     "Archive job cannot switch a partition out",
     "Partition switch blocked because the target does not have a matching index structure"),
]

# Tickets that were closed without a usable resolution — realistic corpus noise.
JUNK = [
    ("Investigating slowness", "Looking into it"),
    ("Ticket raised in error", "Duplicate"),
    ("Please check", "See the linked PR"),
    ("Issue on prod", "Resolved"),
    ("Follow up needed", ""),
]

records = []
seq = 0

def add(title, description, system, severity, patch, resolution, offset_hours, date_style="offset"):
    global seq
    seq += 1
    when = START + datetime.timedelta(hours=offset_hours)
    if date_style == "offset":
        changed = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    elif date_style == "bare":
        changed = when.strftime("%Y-%m-%d")
    elif date_style == "local":
        changed = when.strftime("%Y-%m-%dT%H:%M:%S")
    else:
        changed = None
    records.append({
        "id": f"ADO-{2000 + seq}",
        "title": title,
        "description": description,
        "system": system,
        "severity": severity,
        "resolvedPatch": patch,
        "resolutionDescription": resolution,
        "changedDate": changed,
        "source": "azure-devops",
    })

hours = 0
# Each family recurs several times so later occurrences are learnable from earlier ones.
for name, (patch, system, severity, phrasings) in FAMILIES.items():
    for i, (title, desc) in enumerate(phrasings):
        hours += random.randint(18, 96)
        # Mix date formats: real exports are not uniform.
        style = ["offset", "offset", "offset", "bare", "local", "none"][i % 6]
        # Some tickets legitimately lack a severity or system.
        sev = severity if i % 4 != 3 else ""
        sysname = system if i % 5 != 4 else ""
        add(title, desc, sysname, sev, patch,
            f"Applied {patch}: verified in staging and rolled out.", hours, style)

for name, (patch, system, severity, phrasings) in AMBIGUOUS.items():
    for title, desc in phrasings:
        hours += random.randint(18, 96)
        add(title, desc, system, severity, patch, f"Applied {patch}.", hours)

for title, desc in JUNK:
    hours += random.randint(18, 96)
    add(title, desc, "", "", "", "", hours)

# Novel incidents land last so nothing before them explains the fix.
for patch, system, severity, title, desc in NOVEL:
    hours += random.randint(18, 96)
    add(title, desc, system, severity, patch, f"Applied {patch}.", hours)

records.sort(key=lambda r: (r["changedDate"] or "9999", r["id"]))
out = pathlib.Path("spring-backend/src/test/resources/backtest/sample-incidents.json")
out.write_text(json.dumps(records, indent=2) + "\n")
print(f"wrote {len(records)} incidents -> {out}")
print("distinct fixes:", len({r['resolvedPatch'] for r in records if r['resolvedPatch']}))
print("junk (no fix):", sum(1 for r in records if not r['resolvedPatch']))
