# ADR-007: Cloudflare Tunnel Content Gateway — Full Auth Chain + Mandatory E2E Envelope

**Status:** ADOPTED at G0 closure, 2026-09-10 (G0 output I). GPT-PM VERDICT: APPROVE, 0 BLOCKER /
0 MAJOR. Approval anchor: G0 evidence commit `71ab1cf`. GPT-PM also cited a blob hash for
`governance/plans/G0_PLAN.md` that belongs to a later commit; see `governance/G0_CLOSURE_REPORT.md`.
G0 item C re-verified Cloudflare Tunnel live: outbound-only, "Available on all plans"
(`docs/architecture/EXTERNAL_ASSUMPTIONS.md` C).
**Source:** `docs/architecture/TDD.md` §10.3, §33, §33.1-33.4.

## Context

The Telegram connector host cannot expose an inbound port (NAT, and the design goal of no public
IP). Full-content drill-down (viewing an original Telegram message on demand) must still reach
that host from the PWA. The v0.2 review's B4 finding required the full authentication chain to be
specified, not merely implied, and the SECURITY verdict recommended (as a condition, not a hard
blocker) mandatory application-layer encryption for the Telegram path specifically.

## Decision

- **NAT/reverse access:** Cloudflare Tunnel. The connector host runs `cloudflared` and initiates an
  outbound-only tunnel; no inbound port or public IP is required.
- **Full authentication chain (binding):**
  1. User authenticates to PWA/API via Cloudflare Access-approved identity.
  2. Worker verifies the application session/Access identity and authorization to the requested
     `source_ref`.
  3. Worker creates a one-time signed `ContentRequest` (`request_id`, `source_ref`,
     `client_ephemeral_pubkey`, `expires_at`, `nonce`).
  4. Worker authenticates to the Tunnel-protected Content Gateway with an operator-controlled
     Cloudflare Access service token **and** an application request signature/HMAC.
  5. `cloudflared` transports the request over the outbound Tunnel to the localhost Content
     Gateway.
  6. Gateway validates service identity/signature, expiry, nonce, and `source_ref` policy before
     any TDLib access.
  7. Gateway fetches the source content, encrypts it to the PWA's ephemeral key, returns
     ciphertext.
  8. Worker passes ciphertext through without decryption.
  9. PWA decrypts locally and renders plain text.
     No alternate unauthenticated direct-to-host route is permitted.
- **Mandatory application-layer encryption (Variant A, adopted — not optional):** PWA creates an
  ephemeral WebCrypto P-256 ECDH key pair per authenticated content session; the Gateway holds an
  operator-provisioned rotating P-256 ECDH key pair; ECDH -> HKDF-SHA256 -> AES-256-GCM derives the
  content key; the Cloudflare Worker/Tunnel path carries ciphertext only. Requirements: fresh nonce
  per request, short expiry (<=60s default), AES-GCM associated data binds
  `request_id`/`source_ref`/`schema_version`, replay rejected, Gateway public key pinned via
  authenticated application config with `key_id` rotation support, plaintext never logged/cached
  by Worker/Tunnel application code.

## Consequences

- `services/content-request-broker/` implements steps 2-4/8; `host/content-gateway/` implements
  steps 6-7.
- Gmail drill-down does not need this envelope (TDD §33.1: PWA -> API -> Gmail API directly,
  `Cache-Control: no-store`, no service-worker caching) — this ADR governs the Telegram path only.
- If a future gate needed to fall back to TLS+Access without the ECDH/HKDF/AES-GCM envelope
  (Variant B), that would be a documented, explicitly-accepted risk requiring its own ADR revision
  — "no silent downgrade" (TDD §33.3).

## Verification owed at gate time (G4)

Cloudflare Tunnel outbound-only availability re-verified live (G0 item C); full auth-chain test
(PWA session -> Worker -> Access service token -> `cloudflared` -> Gateway); ECDH/HKDF/AES-GCM
envelope test (fresh nonce, associated data binding, replay rejection, expired-nonce rejection);
Cloudflare Tunnel unavailable resilience test; plaintext-never-logged check on Worker/Tunnel code
paths.
