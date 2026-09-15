# MVP1

Canonical source scope: `../../core/MVP1_SCOPE_LOCK.md`.

Architecture must be read using the current order in `../../CLAUDE.md`:

1. `../architecture/TDD_INVARIANT_AMENDMENTS.md`
2. `../architecture/TDD_ERRATA.md`
3. frozen `../architecture/TDD.md` where not superseded
4. adopted ADRs, including `../../core/adr/ADR-012-telegram-ai-context-policy.md`

## The mandatory proof scenario

```text
Telegram: "Need GO on Gate 4.2"
Gmail:    Subject: Gate 4.2 regression complete
          Body: regression passed; approval requested before rollout
```

With project/stream mapping establishing an `ERP` namespace and business identifier
`ERP::Gate-4.2`, this must resolve to exactly one project, one stream, one cross-source topic, and
one decision with evidence from both sources, drillable down to the original message on either
side.

The existence of mixed-source evidence does **not** itself determine AI eligibility. If an AI path
uses any of this context, each submitted source-derived value must pass the current fail-closed
SourcePolicy/provenance authorization for the exact purpose/context. A denied/unknown/expired/
revoked/incompatible contributor denies the whole call.

## Quantitative evaluation thresholds — existing MVP1 baseline

```text
accepted-event loss under tested transient failures     0
logical duplicate rate                                  <0.5%
auto-merge precision                                     >=95%
linkable-case merge recall                                >=85%
confirmed cross-project false auto-merge                  0
Gmail decision precision                                  >=90%
Gmail decision recall                                     >=85%
Telegram deterministic decision-pattern precision         >=95%
all decisions without evidence                            0
Telegram/mixed AI policy violations                       0
source-derived push payload violations                    0
unresolved DLQ at closure                                 0
```

For the `Telegram/mixed AI policy violations` metric, **violation** now means a call that bypasses
or contradicts the current ADR-012 / invariant-amendment policy — not the mere presence of Telegram
provenance. Examples of violations include missing required consent/authorization, using expired or
revoked scope, consent reuse across another chat/purpose, provenance stripping, connector
self-authorization, or allowing a mixed request with any denied/unknown contributor.
