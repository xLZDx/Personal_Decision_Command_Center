# Observability

Canonical source: `docs/architecture/TDD.md` §46 (three layers: technical health, pipeline
correctness, product quality), §47 (tracing/explainability), §48 (Ops dashboard).

Index only, expanded into real dashboards/metrics at G8.

## Three layers (TDD §46)

```
TECHNICAL HEALTH      connector_up, queue_backlog, D1/Analytics usage, api_latency, ...
PIPELINE CORRECTNESS  ingest_total, duplicate_total, reconcile_reenqueue_total, dlq_count, ...
PRODUCT QUALITY       decision precision/recall, false-merge rate, ...
```

## Trace propagation (TDD §47)

```
source -> connector/spool -> ingest -> outbox -> queue -> processor -> resolver ->
topic/decision -> notification
```

The operator must be able to answer, from OPS/trace data alone and without raw-content logs, the
eleven questions listed in TDD §76 (e.g. "Did event X get accepted?", "Why did a decision
appear?", "Did any restricted provenance touch AI?").
