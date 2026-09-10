# Runbook: Content Gateway Key Rotation

**Status:** placeholder — to be written with real steps at G4 (Telegram connector gate).
**Applies to:** the Gateway's operator-provisioned P-256 ECDH key pair used for the
Telegram drill-down envelope (`../../core/adr/ADR-007-cloudflare-tunnel-content-gateway.md`).

Rotation must be `key_id`-versioned so an in-flight request signed against the old key is not
silently broken mid-rotation. Steps to be added once `host/content-gateway` exists: provision new
key pair, publish new `key_id` via authenticated application config, run overlap window accepting
both `key_id`s, retire the old key, confirm no plaintext was ever logged during rotation.
