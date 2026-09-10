# Runbook: Dead-Letter Queue

**Status:** placeholder — to be written with real steps at G2 (Queue/Reliability gate).
**Trigger:** `dlq_count > 0` (TDD §18 — operational policy: `DLQ count > 0 => OPS RED`;
`P0 accepted-event processing failure => operator-visible incident`).

DLQ records (`event_id`, `error_class`, `error_code`, `processor_version`, `attempt_count`,
`first_failed_at`, `last_failed_at`, `trace_id`) never contain raw content. A terminal DLQ event
is never automatically re-enqueued by the reconciler (INV-29) — manual remediation is required.
Steps to be added once `services/processor`/reconciler exist: inspect trace via `trace_id`,
determine root cause class, decide manual reprocess vs. permanent drop, record the decision in
`../../core/DECISION_LOG.md`.
