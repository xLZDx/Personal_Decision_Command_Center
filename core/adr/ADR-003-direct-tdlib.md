# ADR-003: Direct TDLib for the Telegram Connector

**Status:** DRAFT (G0 output G) — pending operator/GPT-PM adoption at G0 closure.
**Source:** `docs/architecture/TDD.md` §11, §84.

## Context

Telegram requires a persistent client process; there is no equivalent of Gmail's stateless
watch/push for a personal Telegram account. Two integration strategies exist: (a) direct TDLib
(Telegram's own client library) against the operator's personal account, or (b) a Matrix/mautrix
bridge (e.g. via Beeper).

## Decision

MVP1 uses **direct TDLib**, not Matrix/mautrix. The connector authenticates the personal Telegram
account, holds a persistent session, receives new updates, recovers after disconnect using
TDLib's own synchronization, and performs deterministic pattern extraction locally — no embeddings,
no neural classifier, no semantic model (TDD §11.1).

This choice rejects Matrix overhead for a two-source MVP; it does not reject mautrix/Beeper
generally for a future multi-network expansion (TDD §84), which is explicitly POST-MVP.

## Consequences

- No historical bulk backfill on first connection; the adapter tracks `connected_at` and only
  centrally emits events with `occurred_at >= connected_at` (INV-02). TDLib's own first-login local
  cache sync is normal client behavior and stays client-side (MIN-2 closure).
- TDLib version must be pinned with a recorded binary/source checksum; upgrades require a connector
  gate.
- The connector host must be always-on (see `ADR-011` for the related runtime-placement decision
  and `docs/architecture/TDD.md` §10.2 for host ordering preference).
- Session material is high-sensitivity — see `docs/architecture/TDD.md` §40 for storage
  requirements (disk encryption where feasible, root/service-user only permissions, no session
  material in repo/backups unencrypted).

## Verification owed at gate time (G4)

- TDLib version/checksum pinned and recorded.
- `connected_at` boundary test: TDLib initial local cache contains older messages -> none emitted
  centrally before `connected_at`.
- Reconnect-after-6h-outage resilience test.
