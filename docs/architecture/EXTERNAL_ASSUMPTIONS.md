# External Assumptions — Live Verification Snapshots

**G0 outputs B, C, D.** `docs/architecture/TDD.md` §65 requires that every external platform fact
the architecture rests on be re-fetched at the gate that depends on it, rather than trusted from
the TDD's own summary. This file is that record.

Rules for this file:

- Every entry names the **URL actually fetched** and the **fetch date**.
- Where the exact wording matters, the entry carries a **verbatim quote**, not a paraphrase.
- An item that could not be verified says so explicitly. `NOT FOUND` and `AMBIGUOUS` are valid,
  useful entries; a confidently-filled-in guess is not.
- Re-verify at each gate that depends on the item, and on any provider announcement.

---

## B. Telegram — API Terms of Service + Content Licensing / AI Scraping Terms

**Fetched 2026-09-10.** Neither document carries a version number, an effective date, or a
`Last-Modified` header — so "current text" can only be pinned by fetch date plus content hash.

| Document                                | URL                                          | SHA-256 of extracted text                                          |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| API Terms of Service                    | `https://core.telegram.org/api/terms`        | `6ec4b42589a18f5870ebea5ffa4b0fb911ee1a70c98dfd38270e7e8b3c016e33` |
| Content Licensing and AI Scraping Terms | `https://telegram.org/tos/content-licensing` | `760d088692a52c875aae09261d04785811c7cb0caecddc66f89fc94f35defa20` |

### The AI prohibition — verified present, and BROADER than the TDD's summary

API Terms §1.5, verbatim:

> "1.5. Your use of the Telegram API is further subject to the Telegram Terms of Service for
> Content Licensing and AI Scraping. As such, you are prohibited from using, accessing or
> aggregating data obtained from the Telegram platform to train, fine-tune or otherwise engage in
> the development, enhancement or deployment of artificial intelligence, machine learning models
> and similar technologies."

Content Licensing Terms, section "Large Language Models and AI", verbatim:

> "For clarity, Telegram firmly prohibits the scraping, indexing, harvesting, aggregation or use
> of data obtained from its platform to train, fine-tune, validate or otherwise engage in the
> development, enhancement, benchmarking or deployment of artificial intelligence, machine
> learning models and similar technologies."

**Material finding (widening, not relaxation):** the Content Licensing text prohibits five verbs
the TDD's own summary omits — **scraping, indexing, harvesting, validate, benchmarking**. "No LLM
training" is a _narrower_ commitment than the terms actually impose. `indexing` in particular is
the word any future embedding/retrieval design must be measured against — a vector index over
Telegram content would be prohibited by this clause even if no model were ever trained on it.
`benchmarking` and `validate` similarly rule out using Telegram content as an evaluation set,
which a naive reading of "we never train on it" would have permitted. `core/SOURCE_POLICY.md` has
been updated to quote the real text.

### Legitimate-client exception — verified present

Content Licensing Terms, verbatim:

> "Access to user-generated content for any purpose other than ordinary, legitimate, and intended
> use of the Telegram platform as its user is prohibited."

> "As a limited exception, Telegram permits access to data required to launch and operate a
> legitimate third-party Telegram Client, Telegram Bot, or Telegram Mini App, provided that it
> operates in full compliance with the Telegram Terms of Service... Any such data is licensed on a
> retractable, limited, non-exclusive, non-transferable and non-sublicensable basis solely to the
> extent strictly required to operate the relevant service..."

API Terms §1.3/§1.4 additionally require that a client not break expected Telegram behavior —
notably no acting on the user's behalf without consent, no preventing self-destructing content
from disappearing, no tampering with read/typing/online statuses ("ghost mode"). Relevant to G4:
a TDLib connector that reads messages will mark them read in the normal way; do not implement a
"don't mark as read" convenience feature, which §1.4 names explicitly.

### Storage / retention — NOT FOUND (and the TDD does not claim otherwise)

Searched both documents for storage/retention/re-transmission clauses: **none exist.** The nearest
binding constraint is the purpose limit in the licence quoted above ("solely to the extent strictly
required to operate the relevant service"). The project's data-minimization posture
(`core/DATA_RETENTION_POLICY.md`: no central raw Telegram storage by default) is therefore a
project design choice justified by that purpose limit — it is **not** a specific retention rule
imposed by Telegram, and must not be described as one.

### Consent exception — present, and deliberately not used

Content Licensing Terms, verbatim:

> "Exceptions may be granted in instances where all relevant users individually provide explicit,
> informed, affirmative and continued consent that is strictly limited to the specific content and
> chat, channel, or non-global context window for which it was requested. Notably, consent
> obtained in one context is non-transferable and does not grant a license to data in other chats
> or the broader platform."

`INFERENCE` (not quoted text): this requires consent from _all relevant users_ — i.e. the
operator's counterparties, not just the operator — and continued consent at that. For a personal
account holding ordinary two-party chats, obtaining and maintaining that from every counterparty
is not practically reachable, which is why MVP1 does not attempt to rely on this exception. Stated
here so the exception is visibly considered and declined, rather than silently unmentioned.

**Verdict:** the project's Telegram position holds and is, if anything, under-inclusive. Nothing
found weakens INV-03/04/05/26. Re-verify quarterly and before any change to AI scope.

---

## C. Cloudflare — Workers / Queues / D1 / Analytics Engine / Tunnel / Workers AI

**Fetched 2026-09-10.**

| Item                                       | Published value                                                                                                                                                                                                              | Source                                                                                                   | Confidence                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Workers Free requests/day                  | 100,000/day                                                                                                                                                                                                                  | `https://developers.cloudflare.com/workers/platform/limits/`                                             | VERIFIED                                      |
| Workers Free CPU/invocation                | 10 ms (HTTP request row); Paid 5 min, default 30 s                                                                                                                                                                           | same                                                                                                     | VERIFIED                                      |
| How CPU is measured                        | "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time."                                                                                                   | same                                                                                                     | VERIFIED                                      |
| Queue consumer **wall** time               | "Each consumer invocation has a maximum wall time of 15 minutes."                                                                                                                                                            | same                                                                                                     | VERIFIED                                      |
| Queues Free operations                     | 10,000/day. "An operation is counted for each 64 KB of data that is written, read, or deleted."                                                                                                                              | `https://developers.cloudflare.com/queues/platform/pricing/`                                             | VERIFIED                                      |
| Queues Free retention                      | 24 hours, non-configurable                                                                                                                                                                                                   | same                                                                                                     | VERIFIED                                      |
| Batching defaults                          | `max_batch_size` default 10 (range 1-100); `max_batch_timeout` default 5 s (0-60 s); `max_retries` default 3                                                                                                                 | `https://developers.cloudflare.com/queues/configuration/batching-retries/`                               | VERIFIED                                      |
| HTTP pull consumers — mechanics            | `POST /accounts/{id}/queues/{qid}/messages/pull` + `/ack`; `batch_size` default 5 / max 100; `visibility_timeout` default 30 s / max 12 h                                                                                    | `https://developers.cloudflare.com/queues/configuration/pull-consumers/`                                 | VERIFIED                                      |
| HTTP pull consumers — **allowed on Free?** | **NOT FOUND.** The pull-consumers page carries no plan statement at all                                                                                                                                                      | —                                                                                                        | **NOT FOUND**                                 |
| D1 Free rows                               | 5,000,000 read/day; 100,000 written/day                                                                                                                                                                                      | `https://developers.cloudflare.com/d1/platform/pricing/`                                                 | VERIFIED                                      |
| D1 Free storage                            | 500 MB per database; 5 GB per account; 10 databases                                                                                                                                                                          | `https://developers.cloudflare.com/d1/platform/limits/`                                                  | VERIFIED                                      |
| D1 Free **queries per Worker invocation**  | **50** (Paid: 1,000)                                                                                                                                                                                                         | same                                                                                                     | VERIFIED — **new constraint, not in TDD §65** |
| D1 Time Travel                             | 7 days Free (30 days Paid)                                                                                                                                                                                                   | same                                                                                                     | VERIFIED                                      |
| D1 over-limit behavior                     | "Beginning September 1, 2026, D1 queries on the Workers Free plan will fail when an account exceeds the daily row read or row write limits" — errors "until the limit resets at midnight UTC"                                | `https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/`            | VERIFIED — project's belief confirmed         |
| Analytics Engine Free                      | 100,000 data points/day; 10,000 read queries/day; 3-month retention; 250 data points per Worker invocation; "Currently, you will not be billed for your use of Workers Analytics Engine."                                    | `https://developers.cloudflare.com/analytics/analytics-engine/pricing/`                                  | VERIFIED — **closes MIN-5**                   |
| Cloudflare Tunnel                          | "outbound-only, post-quantum encrypted connection"; page badge "Available on all plans"                                                                                                                                      | `https://developers.cloudflare.com/tunnel/`                                                              | VERIFIED (badge, not prose)                   |
| Workers AI data use                        | "Cloudflare does not use your Customer Content to (1) train any AI models made available on Workers AI or (2) improve any Cloudflare or third-party services, and would not do so unless we received your explicit consent." | `https://developers.cloudflare.com/workers-ai/platform/data-usage/`                                      | VERIFIED                                      |
| Workers AI REST + free allocation          | REST at `/client/v4/accounts/{id}/ai/run/@cf/...` with Bearer token; "10,000 Neurons per day at no charge", resets 00:00 UTC                                                                                                 | `https://developers.cloudflare.com/workers-ai/get-started/rest-api/`, `.../workers-ai/platform/pricing/` | VERIFIED — **limit not in TDD §65**           |

### The NB1 contradiction is NOT resolved — and it is now three-way

This was the sole BLOCKER of the v0.2 adversarial review. Re-fetching the live docs did not settle
it; it made it worse:

1. **Workers limits page** — the CPU-time table has rows only for _HTTP request_ (10 ms Free) and
   _Cron Trigger_ (10 ms Free). **There is no Queue-consumer row in the CPU table at all.** Queue
   consumers appear only in the separate _wall time_ table (15 minutes).
2. **Queues limits page** — "By default, the maximum CPU time per consumer Worker invocation is set
   to 30 seconds, but can be increased by setting `limits.cpu_ms`" (up to 5 minutes), sitting under
   a blanket header saying the limits "apply to both Workers Paid and Workers Free plans with the
   exception of Message Retention". Read literally, that grants 30 s / 5 min on Free.
3. **Workers pricing page** — "Max of 15 minutes of CPU time per Cron Trigger or Queue Consumer
   invocation", and this line sits in the **Paid** column; the Free column says only "10
   milliseconds of CPU time per invocation", with no queue exception.

The paid-side figure has also drifted between pages (15 min on pricing vs 5 min on the Queues
page), which is itself evidence that these pages are not being maintained against each other.

**No Cloudflare page states a Free-plan queue-consumer CPU figure explicitly.** The conservative
10 ms assumption in `core/adr/ADR-011-queue-consumer-runtime.md` therefore stands unchanged, and
`scripts/probes/cloudflare-free-cpu/` remains the answer of record — this is precisely the case
where documentation cannot substitute for measurement. `core/RISK_REGISTER.md` R8 stays OPEN.

### New findings that change the design (not in TDD §65)

- **D1 Free allows only 50 queries per Worker invocation** (Paid: 1,000). The consumer's budget is
  therefore _two_ ceilings, not one: ~10 ms CPU **and** ≤50 D1 queries. A design that fetches
  `MAX_TOPIC_CANDIDATES = 20` candidates one query at a time, plus dedupe/state/audit writes, is
  uncomfortably close to that ceiling — candidate fetching must be a single batched query, not a
  loop. Binding on G2.
- **A Queue "operation" is counted per 64 KB**, not per message. Small metadata-only payloads (the
  design's `{event_id, operation, schema_version}`) are therefore 1 operation each — which is what
  the ~3 ops/message (write+read+delete) estimate assumes. Confirms the ~3,300 messages/day
  practical ceiling against the 10,000 ops/day budget, and confirms that keeping bodies out of the
  Queue payload is a cost control as well as a privacy one.
- **Workers AI free allocation is 10,000 Neurons/day**, resetting at 00:00 UTC. `ADR-009`/`ADR-010`
  must treat this as the AI quota ceiling for HARD_ZERO purposes; the TDD's §65 table does not
  record it.
- **Whether HTTP pull consumers are available on the Free plan is NOT documented anywhere.** This
  matters more than it looks: the pull consumer is `ADR-011`'s _pre-approved fallback_ for the case
  where the Worker CPU budget proves too tight. A fallback whose availability on the target plan is
  unverified is not yet a fallback. G0 closure must record this as an open item, and the empirical
  probe should be extended to attempt a pull-consumer `pull`/`ack` call on the same Free account.

---

## D. Gmail — watch / history / Pub/Sub / quotas / scopes

**Fetched 2026-09-10.**

| Item                                  | Finding                                                                                                                                   | Source                                                                                                   | Confidence |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| `users.watch` lifetime                | Must be called at least every 7 days; Google recommends once per day                                                                      | `https://developers.google.com/workspace/gmail/api/guides/push`                                          | VERIFIED   |
| Stale `startHistoryId`                | Returns HTTP 404; client must then perform a full sync. History records "typically available for at least one week", sometimes only hours | `https://developers.google.com/workspace/gmail/api/guides/sync`                                          | VERIFIED   |
| Pub/Sub push auth                     | OIDC JWT in the authorization header; verify signature, `email` and `audience` claims against the push-subscription config                | `https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions`                              | VERIFIED   |
| Pub/Sub push auth default             | **Authentication is optional and OFF by default** — "Optional: To enable authentication, follow these steps"                              | `https://docs.cloud.google.com/pubsub/docs/create-push-subscription`                                     | VERIFIED   |
| Billing account required for Pub/Sub? | **AMBIGUOUS — not settled by the documentation.** See below                                                                               | multiple                                                                                                 | AMBIGUOUS  |
| Gmail API quotas                      | 80,000,000 units/day/project; 6,000 units/min/user; `history.list`=2, `messages.list`=5, `messages.get`=20, `watch`=100                   | `https://developers.google.com/workspace/gmail/api/reference/quota`                                      | VERIFIED   |
| Minimum OAuth scope                   | `gmail.readonly` covers both `watch` and message bodies; `gmail.metadata` covers `watch` but not bodies; no send scope needed             | `https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch`, `.../api/auth/scopes` | VERIFIED   |

### Correction to the TDD's framing of gap recovery

Google's **documented** recovery from a 404 history cursor is a **full sync**, not a bounded one.
`docs/architecture/TDD.md` §12.1 describes bounded recovery beginning no earlier than
`connected_at` as though it were the required procedure. It is not — it is _this project's own
engineering decision_, made because an unbounded full sync would violate the no-backfill invariant
and silently import years of old mail. The decision is correct and stays; the attribution must be
accurate. Recorded rather than silently kept, per `CLAUDE.md` §8.

### Pub/Sub authentication is opt-in — design consequence

Because unauthenticated push endpoints are the platform default, "we verify OIDC/JWT" is not
something the project inherits by using Pub/Sub; it is something G3 must deliberately configure
**and test negatively** (an unsigned push must be rejected). A G3 that merely enables push and
sees messages arrive has proven nothing about authentication.

### The billing question — genuinely unresolved, with the experiment that settles it

The documentation points both ways:

- Every Pub/Sub quickstart states, verbatim: "Verify that billing is enabled for your Google
  Cloud project." (`https://docs.cloud.google.com/pubsub/docs/create-topic-console`)
- "A Google Cloud billing account is required to access the Google Cloud Free Tier."
  (`https://docs.cloud.google.com/free/docs/free-cloud-features`)
- But Cloud APIs generally: "**Some** Cloud APIs charge for usage. You need to enable billing for
  your project before you can start using these APIs"
  (`https://docs.cloud.google.com/apis/docs/getting-started`) — "some", and Pub/Sub is not named.
- The Pub/Sub quotas page mentions billing **nowhere**, and publishes no billing-enabled-vs-not
  quota split (`https://docs.cloud.google.com/pubsub/quotas`).
- The Gmail push guide never mentions billing, only "fulfill the Cloud Pub/Sub prerequisites".

No fetched page states that `pubsub.googleapis.com` cannot be enabled, or that a topic cannot be
created, without a billing account. The quickstart line is a prerequisite instruction, not an
enforcement statement.

**Decisive experiment (G3, ~10 minutes, operator-run — needs a Google account, so not Claude's to
run):** create a fresh Google Cloud project, attach **no** billing account, then
`gcloud services enable pubsub.googleapis.com` followed by `gcloud pubsub topics create`. If
either fails with a billing-required error, push is unavailable under HARD_ZERO and
`GMAIL_COLLECTION_MODE=POLL` is the mode of record. If both succeed, run one `users.watch`
end-to-end and watch for a billing prompt at first publish.

**Design consequence, binding on G3:** until that experiment returns, the ingestion layer must
keep push and poll interchangeable behind one interface. Do not let a "push works on my account"
result harden into an architecture that cannot fall back. `core/RISK_REGISTER.md` R3 stays open.

### Quota headroom for the poll fallback

Polling `history.list` every 5 minutes is 288 calls/day ≈ 576 quota units against 80,000,000/day
— roughly five orders of magnitude of headroom, even adding 100 full `messages.get` fetches
(2,000 units). The HARD_ZERO poll fallback is comfortably viable at personal scale.

### Restricted-scope note

`INFERENCE` (from the scope's restricted classification, not a quoted sentence): `gmail.readonly`
is a _restricted_ scope, so a **public** app would face Google's CASA security assessment. A
single-user app kept in Testing mode does not. MVP1 is single-user by design
(`docs/architecture/TDD.md` §38), so this should not bite — but it is a reason not to casually
publish the OAuth consent screen.
