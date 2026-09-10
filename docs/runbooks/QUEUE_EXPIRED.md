# Runbook: Queue Message Expiry

**Status:** placeholder — to be written with real steps at G2 (Queue/Reliability gate).
**Trigger:** a Queue message aged out past Free-tier 24h retention before being dispatched
(TDD §17).

D1 durable ingest/outbox remains source of truth — a Queue write never proves eventual processing.
The Processing Reconciler re-enqueues only non-terminal accepted work
(`state IN (ACCEPTED, RETRYABLE_FAILED) AND next_attempt_at <= now AND attempt_count < MAX_PROCESSING_ATTEMPTS`),
explicitly excluding `PROCESSED`/`DLQ`/permanent failures (NM4 closure — see
`../../core/RISK_REGISTER.md`). Mandatory resilience case: simulated >24h outage -> reconciler
re-enqueues -> event eventually `PROCESSED` -> no duplicate domain state.
