# Runbook: Restore

**Status:** placeholder — to be written with real steps at G8 (Observability/Backup gate).
**Applies to:** recovering from `host/backup-agent`'s D1 export backups (TDD §53-54, §77).

A backup is not valid until an isolated restore test succeeds — this runbook is not optional
documentation, it is the thing that proves `DEFINITION_OF_DONE`'s backup/DR item is real. Steps
to be added once `host/backup-agent` exists: restore isolated database, validate migrations/
schema, validate row counts, validate critical constraints, open a representative
Project->Topic->Decision path, produce a restore report. Targets: catastrophic metadata RPO
<=24h, manual RTO <=4h (no enterprise-HA claim).
