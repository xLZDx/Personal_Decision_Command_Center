# MVP1

Canonical scope: `../../core/MVP1_SCOPE_LOCK.md`. Functional deliverables: `docs/architecture/TDD.md`
§78. Exit criteria: `docs/architecture/TDD.md` §82 (no partial closure).

## The mandatory proof scenario (TDD §79)

```
Telegram: "Need GO on Gate 4.2"
Gmail:    Subject: Gate 4.2 regression complete
          Body: regression passed; approval requested before rollout
```

With project/stream mapping establishing an `ERP` namespace and business identifier
`ERP::Gate-4.2`, this must resolve to exactly one project, one stream, one cross-source topic, and
one decision with evidence from both sources, drillable down to the original message on either
side.

## Quantitative evaluation thresholds (TDD §80) — the numbers a shadow run must hit before closure

```
accepted-event loss under tested transient failures     0
logical duplicate rate                                  <0.5%
auto-merge precision                                     >=95%
linkable-case merge recall                                >=85%
confirmed cross-project false auto-merge                  0
Gmail decision precision                                  >=90%
Gmail decision recall                                      >=85%
Telegram deterministic decision-pattern precision           >=95%
all decisions without evidence                              0
Telegram/mixed AI policy violations                          0
source-derived push payload violations                       0
unresolved DLQ at closure                                     0
```
