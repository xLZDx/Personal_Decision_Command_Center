# External Assumptions — Live Verification Snapshots

This file records external platform facts that architecture depends on. External terms are mutable; re-fetch the primary source at every gate that materially depends on the fact and on any provider announcement.

Rules:

- record URL + fetch date;
- quote only when exact wording is load-bearing;
- distinguish provider text from project inference;
- `NOT FOUND` / `AMBIGUOUS` are valid outcomes;
- never turn a conservative project choice into a claimed provider requirement.

---

## B. Telegram — API / Content Licensing / Bot Platform / Privacy

### Snapshot 1 — G0, 2026-09-10

The original G0 snapshot fetched:

| Document | URL | SHA-256 of extracted text |
| --- | --- | --- |
| API Terms of Service | `https://core.telegram.org/api/terms` | `6ec4b42589a18f5870ebea5ffa4b0fb911ee1a70c98dfd38270e7e8b3c016e33` |
| Content Licensing / AI Scraping Terms | `https://telegram.org/tos/content-licensing` | `760d088692a52c875aae09261d04785811c7cb0caecddc66f89fc94f35defa20` |

That snapshot correctly found:

- API Terms bind API use to Content Licensing / AI terms;
- broad scraping/indexing/harvesting/aggregation/training/fine-tuning/validation/benchmarking/deployment AI uses are prohibited absent the applicable exception;
- normal third-party Client/Bot/Mini-App operation has a limited legitimate-service exception;
- AI terms contain a context-bounded consent exception requiring explicit/informed/affirmative/continued consent from relevant users;
- API clients may not implement ghost-mode/read-status tampering or act on the user's behalf without required consent.

The **old project inference** that MVP1 should permanently decline every Telegram AI path is superseded by ADR-012 and the invariant amendments. The provider facts above remain; the product conclusion changed.

### Snapshot 2 — policy reconciliation, 2026-09-15

Re-fetched:

- `https://core.telegram.org/api/terms`
- `https://telegram.org/tos/content-licensing`
- `https://telegram.org/tos/bot-developers`
- `https://telegram.org/privacy`

Current material findings:

#### API / Content Licensing

API Terms §1.5 still binds Telegram API data use to the Content Licensing / AI rules.

Content Licensing still contains both:

1. a limited exception for data required to launch/operate a legitimate third-party Telegram Client, Bot or Mini App, subject to the other terms; and
2. an AI-specific restriction with an exception where relevant users provide explicit, informed, affirmative, continued consent limited to the specific content/chat/channel/non-global context window.

**Project interpretation:** the legitimate-client exception alone must NOT be treated as blanket permission for AI. AI use still needs the applicable AI-specific consent/authorization basis.

#### Bot Platform Developer Terms

The Bot Developer Terms materially change the old binary product interpretation:

- Bots/Mini Apps are explicitly third-party applications providing services through Telegram;
- the developer must publish an accurate privacy policy for its processing;
- data collection/processing beyond what is essential to the service is prohibited;
- data submitted directly and voluntarily to a TPA may be used when users are clearly informed of the intended use and provide individual, explicit, active and revocable consent;
- Telegram Business chatbot data may not be disclosed to third-party APIs without the required user authorization;
- retention must end when no longer necessary/authorized and user deletion requests must be honored where applicable.

**Project interpretation:** Bot/Mini-App/Business-chatbot contexts can support an AI-enabled service path when the relevant disclosure/consent/authorization requirements are actually implemented and provable. This is not blanket permission for arbitrary Telegram data.

#### Telegram Privacy Policy

The Privacy Policy confirms that:

- users intentionally interacting with bots send relevant data to third-party bot developers;
- Telegram Business users can connect third-party bots to process/respond to messages;
- Business chatbots can receive messages/media/files from the private chats they are permitted to manage;
- Business chatbot permissions can be changed/revoked by the account owner.

**Project interpretation:** Telegram officially supports third-party automation/AI-adjacent service operation, but the application's use of that data remains bounded by the Content Licensing, Bot Developer Terms, disclosure/consent/authorization and applicable privacy law.

### Binding engineering conclusion after 2026-09-15 reconciliation

The old rule:

```text
Telegram provenance => permanent AI_DENY
```

is superseded.

The current engineering rule is:

```text
Telegram provenance => evaluate current Telegram SourcePolicy for this exact
                       ingress mode + purpose + content/chat/context +
                       consent/authorization + provider-terms snapshot.

unknown / expired / revoked / incompatible / unprovable => DENY
```

Practical consequences:

- `PERSONAL_TDLIB_CLIENT`: AI_DENY by default; ALLOW requires the applicable relevant-user, context-bounded consent to be provable. Operator consent alone must not be assumed to cover ordinary counterparties.
- `BOT_PLATFORM_DIRECT` / `MINI_APP`: direct intentionally submitted data may become AI-eligible when the app clearly discloses intended use and captures the required explicit/active/revocable/context-bounded consent.
- `BUSINESS_CHATBOT`: may become AI-eligible only for authorized chat scope/purpose with truthful disclosure and the required authorization for third-party APIs/AI processing.
- mixed Gmail+Telegram context is not automatically denied or allowed; every submitted provenance ancestor must independently be current ALLOW for the same purpose/context with compatible scopes.
- broad Telegram scraping, historical AI indexing, training/fine-tuning, benchmark/validation datasets and embeddings are NOT authorized by this reconciliation as a class.

See:

- `core/adr/ADR-012-telegram-ai-context-policy.md`
- `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`
- `core/SOURCE_POLICY.md`

### Storage / retention

The original API/Content Licensing snapshot did not establish a simple fixed retention duration. Bot Platform terms add explicit service/data-minimization and deletion obligations for TPA data.

The project's no-central-raw-Telegram-body-by-default posture remains a valid minimization design choice. Any future AI-enabled Telegram path must additionally define revocation/deletion/invalidation semantics where required by the ingress mode/provider terms/applicable law.

---

## C. Cloudflare — Workers / Queues / D1 / Analytics Engine / Tunnel / Workers AI

**Fetched 2026-09-10.** Re-verify before gates that depend on current limits/terms.

| Item | Published / verified value |
| --- | --- |
| Workers Free requests/day | 100,000/day |
| Workers Free HTTP CPU | 10 ms/invocation at snapshot |
| Queue consumer wall time | 15 minutes |
| Queues Free operations | 10,000/day, counted per 64 KB written/read/deleted |
| Queues Free retention | 24 hours |
| Queue batching | default max batch 10, timeout 5s, retries 3 |
| HTTP pull mechanics | pull + ack APIs documented; Free-plan availability was NOT FOUND |
| D1 Free rows | 5M read/day; 100K written/day |
| D1 Free storage | 500 MB/database; 5 GB/account; 10 databases |
| D1 queries / Worker invocation | 50 Free |
| D1 Time Travel | 7 days Free |
| Analytics Engine Free | 100K points/day; 10K read queries/day; 3-month retention |
| Tunnel | outbound-only; available on all plans at snapshot |
| Workers AI customer-content use | documented as not used to train/improve services without explicit consent at snapshot |
| Workers AI free allocation | 10,000 Neurons/day at snapshot |

### Queue-consumer CPU ambiguity

Cloudflare pages did not publish one unambiguous Free-plan Queue-consumer CPU figure. The project therefore keeps the conservative measured assumption in `ADR-011-queue-consumer-runtime.md` rather than upgrading the budget from contradictory prose.

### D1 / Queue design consequences

- D1 has both row/day ceilings and a per-invocation query ceiling; candidate lookup must be batched/indexed rather than a per-candidate query loop.
- Queue cost is per 64 KB operation, so metadata-only payloads are both a privacy and HARD_ZERO cost control.
- HTTP pull on Free remained unverified in the G0 snapshot and cannot be treated as a proven fallback without an empirical/provider confirmation.

---

## D. Gmail — watch / history / Pub/Sub / quotas / scopes

**Fetched 2026-09-10.**

Verified at snapshot:

- `users.watch` must be renewed at least every 7 days; Google recommends daily renewal;
- stale `startHistoryId` may return 404 and Google's documented recovery is a full sync;
- project deliberately constrains recovery to avoid pre-connection historical import;
- authenticated Pub/Sub push requires deliberate OIDC/JWT configuration; auth is not automatically on;
- Gmail API quotas were published at 80M units/day/project and 6,000 units/min/user; `history.list`/`messages.list`/`messages.get`/`watch` have different unit costs;
- `gmail.readonly` covers watch + message bodies; `gmail.metadata` does not cover body retrieval;
- billing-account requirements for the intended Pub/Sub/HARD_ZERO setup were still ambiguous and require the gate's empirical check/fallback decision.

### Gap-recovery attribution

Google's documented 404 recovery is a full sync. The project's bounded recovery beginning no earlier than `connected_at` is an intentional product/privacy engineering constraint, not a Google requirement.

### Pub/Sub auth

A G3 implementation must prove that unauthenticated/incorrectly authenticated pushes are rejected; merely observing successful push delivery does not prove authentication is configured.

### HARD_ZERO poll fallback

Polling `history.list` at personal scale has very large quota headroom relative to the published Gmail quota and remains the intended fallback if the Pub/Sub/billing path is incompatible with HARD_ZERO.

### OAuth scope note

`gmail.readonly` is a restricted scope. MVP1 remains single-user; do not casually convert the OAuth application into a public distribution model without re-evaluating Google's verification/security-assessment requirements.
