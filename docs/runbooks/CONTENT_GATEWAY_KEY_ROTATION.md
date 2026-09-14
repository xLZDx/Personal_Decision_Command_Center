# Runbook: Content Gateway Key Rotation

**Status:** operational draft for the G4 ECDH envelope slice.
**Applies to:** the Gateway's operator-provisioned P-256 ECDH key pair used for the
Telegram drill-down envelope (`../../core/adr/ADR-007-cloudflare-tunnel-content-gateway.md`).

Rotation must be `key_id`-versioned so an in-flight request signed against the old key is not
silently broken mid-rotation.

1. Generate a new P-256 ECDH pair in the operator secret store; do not write private JWK material
   to the repository, shell history, logs, or an unencrypted file.
2. Publish the new public JWK and `key_id` through authenticated application configuration. Keep
   the old public key available for the bounded overlap window (at most one request expiry window).
3. Exercise one authenticated drill-down against each key ID. Verify the PWA decrypts locally,
   the Worker/Tunnel sees ciphertext only, and a changed AAD fails authentication.
4. Retire the old key after the overlap window and reject requests naming the retired `key_id`.
5. Record the key IDs, timestamps, and test outcome in the decision log; never record key bytes or
   plaintext. If any plaintext appears in logs, stop rotation and escalate as a compromise.
