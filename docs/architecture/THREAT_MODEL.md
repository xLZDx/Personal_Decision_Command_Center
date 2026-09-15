# Threat Model

**Status:** G0 baseline reviewed/adopted 2026-09-10; Telegram-AI policy boundary updated by `ADR-012-telegram-ai-context-policy.md` and `TDD_INVARIANT_AMENDMENTS.md`.

The old G0 claim that the only safe MVP1 AI input is permanently Gmail-only is historical. The current security property is stronger and more general: **no source-derived value reaches AI unless the fail-closed SourcePolicy + provenance evaluator authorizes that exact value/context/purpose.** Telegram remains deny-by-default where required consent/authorization is absent or unprovable.

Re-review is owed at any source-policy change, any widening of AI scope, quarterly for mutable provider terms, and whenever a gate adds a new trust boundary.

## Threat catalogue

```text
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
consent fabrication / consent-scope escalation
consent revocation not taking effect
provider-ingress confusion (TDLib vs Bot vs Business chatbot)
```

## Controls mapped to threats

| Threat | Primary control |
| --- | --- |
| Stolen session | short-lived authenticated sessions; re-auth for sensitive changes |
| Gmail OAuth compromise | PKCE, encrypted refresh token storage, least privilege, revocation |
| Telegram session theft | connector-host hardening, restricted session material, revocation runbook |
| Connector-host compromise | treat as source-account incident; revoke credentials/session |
| Malicious source / prompt injection | source content is untrusted data; AI has no connector credentials or policy-mutation rights; schema-validated output; safe rendering |
| Webhook spoofing | provider authentication verification (e.g. Gmail Pub/Sub OIDC/JWT) |
| Telegram content-request replay | short-lived nonce, authenticated request, AEAD-bound request metadata, replay rejection |
| Queue replay / duplicate processing | source-stable idempotency + idempotent consumer |
| XSS/CSRF | CSP, safe cookies, CSRF controls, safe rendering/security headers |
| Supply-chain compromise | pinned/checksummed dependencies, CI scanning, least-privilege tokens |
| Backup theft | authenticated encryption before remote storage; keys separated |
| Operator error | gate governance, decision log, restore-tested backups |
| Policy bypass through derived state | provenance DAG + trusted policy-authorized AI input builder; no generic Topic/object bypass |
| Consent fabrication | consent records are trusted application state, not model/source claims; source content cannot create/expand consent |
| Consent-scope escalation | explicit chat/content/context + purpose scope; non-transferable between contexts/purposes |
| Revocation lag | revocation/expiry checked immediately before AI authorization; subsequent calls fail closed |
| Ingress-mode confusion | SourcePolicy distinguishes personal TDLib, Bot/Mini-App and Business-chatbot semantics instead of one Telegram boolean |

## Telegram AI-specific security model

Telegram provenance is not a permanent deny bit and is never removed.

At an AI boundary it triggers policy evaluation under ADR-012:

```text
personal TDLib without required scoped consent        DENY
unknown/expired/revoked consent                       DENY
bot/mini-app direct interaction with valid scoped consent  potentially ALLOW
business-chatbot context with valid scope/authorization    potentially ALLOW
mixed Gmail+Telegram where every submitted ancestor ALLOW  potentially ALLOW
one denied/unknown/incompatible ancestor              whole call DENY
```

'Potentially ALLOW' still requires all other provider/model/HARD_ZERO/security policies to pass.

The existence of a Telegram Bot, Mini App or Business-chatbot feature is never accepted as proof of blanket AI permission.

## Residual risks

- Push timing side-channel remains even with opaque payloads.
- OS app-switcher snapshots may reveal rendered UI content.
- Connector-host catastrophic loss before central ACK may lose not-yet-acked source events.
- Provider terms can change without notice; dated primary-source re-verification is therefore a required operational control.

## Verification owed at the runtime policy-migration gate

In addition to existing security tests, independently prove:

- policy-authorized AI builder has no generic object bypass;
- personal TDLib chat without required consent is denied;
- valid scoped Bot/Mini-App/Business context can be authorized only through trusted policy state;
- chat/purpose scope cannot leak to another chat/purpose;
- revocation/expiry blocks the next AI call;
- mixed context with one deny/unknown node fails the entire call;
- provenance stripping/relabeling is detected/prevented;
- source payload/model output cannot mutate consent/SourcePolicy;
- current normalized-event guard migration does not make connector-controlled `ai_policy=ALLOW` authoritative;
- provider/model quota and AI-disabled degradation remain safe;
- raw source content logging/storage rules do not regress.
