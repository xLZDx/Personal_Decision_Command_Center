# Threat Model

**Status:** G0 output N — **REVIEWED AND ADOPTED at G0 closure, 2026-09-10.** The independent
review was performed by GPT-PM in fresh context, acting as the SEC/PRIV reviewer, which satisfies
the "at least one substantive review is fresh-context independent from the implementer context"
requirement (`../../core/DEFINITION_OF_DONE.md` item 21) for G0. Its verdict: no new
BLOCKER/MAJOR, and specifically that the Telegram→AI boundary is closed tightly enough — the only
MVP1 AI input is Gmail-only pre-merge evidence, and combined Gmail+Telegram state never returns to
AI.

Re-review is owed at any source-policy change, quarterly, and whenever a gate adds a new trust
boundary (`../../core/SOURCE_POLICY.md`). The per-gate verification table at the end of this file
is what each later gate is measured against — adoption here is not a claim that those tests have
run.

## Threat catalogue (TDD §37)

```
stolen phone/browser session
OAuth token compromise
Telegram session theft
connector-host compromise
malicious inbound email/message
prompt injection
webhook spoofing
replay attack
queue replay
duplicate action execution
XSS/CSRF
supply-chain compromise
backup theft
operator error
policy bypass through derived state
```

## Controls mapped to threats

| Threat                                             | Primary control                                                                                                                                                                                                                                  | Where enforced                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Stolen phone/browser session                       | Short-lived authenticated session, re-auth for sensitive changes                                                                                                                                                                                 | `services/api`, PWA session layer (§38)                                    |
| OAuth token compromise (Gmail)                     | PKCE, encrypted refresh-token storage, key-encryption secret outside D1 as Worker Secret, never client-readable/logged/in URLs, revocable, least privilege                                                                                       | `connectors/gmail` (§39)                                                   |
| Telegram session theft                             | Connector-host disk encryption where feasible, root/service-user only permissions, no session material in repo/backups unencrypted, revocation runbook                                                                                           | `connectors/telegram-tdlib`, `host/` (§40)                                 |
| Connector-host compromise                          | Treated as source-account incident; session revocation runbook                                                                                                                                                                                   | `host/`, `docs/runbooks/CONNECTOR_KEY_COMPROMISE.md`                       |
| Malicious inbound email/message / prompt injection | Source content is untrusted data, never trusted instruction (INV-25); AI has no tools/credentials/policy-mutation rights; schema-validated output; human-facing AI fields are plain-text, length-capped, no links unless independently generated | `packages/policy`, `services/decision` (§44)                               |
| Webhook spoofing (Gmail Pub/Sub)                   | OIDC/JWT identity + audience verification; unsigned/unexpected pushes rejected                                                                                                                                                                   | `connectors/gmail` (§12)                                                   |
| Replay attack (Telegram content requests)          | Fresh nonce per request, <=60s expiry, AES-GCM associated data binds request_id/source_ref/schema_version, replay rejected                                                                                                                       | `services/content-request-broker`, `host/content-gateway` (§33.3, ADR-007) |
| Queue replay / duplicate action execution          | Idempotency key `(source_account_id, source_event_id, event_type, source_version_if_needed)`; idempotent consumer                                                                                                                                | `services/ingest`, `services/processor` (§14, INV-08)                      |
| XSS/CSRF                                           | Strict CSP, no unsafe-eval/inline, HttpOnly/Secure/SameSite cookies, CSRF protection, Referrer-Policy, Permissions-Policy, X-Content-Type-Options, Trusted Types where practical                                                                 | `apps/pwa` (§43)                                                           |
| Supply-chain compromise                            | TDLib version/checksum pinned; dependency scan in CI; least-privilege API tokens (no Global API keys)                                                                                                                                            | CI (`.github/workflows`), `ADR-003`                                        |
| Backup theft                                       | Local compress + authenticated encryption before R2 upload; backup key/passphrase kept outside R2; operator-held recovery/escrow procedure                                                                                                       | `host/backup-agent` (§53)                                                  |
| Operator error                                     | Gate manifests/operator-approvals as protected paths; decision log; restore-tested backups                                                                                                                                                       | `governance/`, `docs/runbooks/RESTORE.md`                                  |
| Policy bypass through derived state                | Provenance DAG + fail-closed composition rule; `Topic`/`Stream`/`Person` objects are type/schema-blocked from the AI API, not just policy-blocked                                                                                                | `packages/provenance`, `packages/policy` (ADR-005)                         |

## Accepted residual risks (not mitigated further, documented deliberately)

- **Push timing side-channel (INV-31, R7):** FCM/APNs can observe that a push occurred and when,
  even though payload content is opaque (`ADR-008`). INFO severity, not blocking.
- **App-switcher OS snapshot (§43):** operating systems may show app-switcher snapshots of the PWA;
  accepted platform risk, optionally mitigated by blurring sensitive views on visibility change.
- **Catastrophic connector-host disk loss before central ACK (§15):** events not yet durably ACKed
  centrally may be unrecoverable from source history alone; mitigated, not eliminated, by TDLib
  reconnect/source-difference recovery testing.

## Verification owed at gate time

Pub/Sub OIDC/JWT authentication test; connector replay-protection test; connector key-rotation
test (or exercised in staging); Cloudflare Tunnel `ContentRequest` full auth-chain test; Telegram
ECDH/HKDF/AES-GCM envelope test (expired/replayed nonce rejected); CSP/security-header
verification; raw-content-logging-clean test; opaque-push-payload test; AI human-facing field
plain-text/length-cap test; prompt-injection test suite; TDLib dependency/checksum verification;
backup encryption/recovery-key procedure test; gate-manifest/operator-approval integrity CI check.
See `docs/architecture/TDD.md` §74 (Security DoD) for the full binding list.
