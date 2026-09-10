# ADR-006: Durable Ingest / Outbox

**Status:** NOT YET REQUIRED for G0 closure — placeholder per `docs/architecture/TDD.md` §55's
repository tree. To be written and adopted no later than G2 planning (D1 schema/ingest gate),
drawing on TDD §14 (durable ingest contract: accept -> D1 transaction -> ACK source), §17
(outbox/retry/reconciliation states), and NM4's poison-loop closure (reconciler excludes terminal
`FAILED`/`DLQ`, `MAX_PROCESSING_ATTEMPTS=5`).
