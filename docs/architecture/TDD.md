# Personal Decision OS
## Technical Design Document / Architecture Specification v0.3 FINAL

**THIS FILE IS THE TECHNICAL DESIGN DOCUMENT, NOT THE REVIEW PROMPT.**

**Date:** 2026-09-10  
**Status:** FINAL IMPLEMENTATION BASELINE - READY FOR GATE-BY-GATE IMPLEMENTATION  
**Implements corrections from:** TDD v0.1 review + TDD v0.2 adversarial review + GPT-PM verification  
**Implementation owner:** Claude  
**Governance owner / final gate authority:** GPT-PM + Operator  
**MVP1 approved source scope:** **Gmail + personal Telegram ONLY**  
**Primary client:** Mobile-first PWA: Android + iPhone + Web  
**Desktop:** not required for normal production use  
**MVP1 cost constraint:** mandatory recurring infrastructure cost target = **$0/month**  
**Architecture mode:** compliance-first, event-driven, evidence-first, source-policy-aware, human-controlled

---

# 0. Executive decision

Personal Decision OS is not another unified inbox. It is a personal work, knowledge and decision operating layer.

The system continuously receives newly arriving communication events, converts them into a normalized stream, associates them with people/projects/workstreams/topics, tracks state and commitments, and presents the user with a consolidated prioritized list of decisions and actions regardless of originating channel.

The core transformation is:

```text
NEW EVENTS
   ↓
SOURCE-SPECIFIC COLLECTORS
   ↓
NORMALIZED EVENT STREAM
   ↓
IDENTITY / PROJECT / STREAM
   ↓
TOPIC / INTENT
   ↓
KNOWLEDGE / DELIVERABLE / COMMITMENT / MILESTONE STATE
   ↓
DECISION / ACTION
   ↓
DETERMINISTIC PRIORITY
   ↓
OPAQUE PUSH
   ↓
TODAY / DECISION CENTER
   ↓
FULL SOURCE DRILL-DOWN ON DEMAND
```

The primary UX question is:

```text
What needs my attention now?
```

not:

```text
Which inbox should I check?
```

MVP1 proves this hypothesis with **two sources only: Gmail and the user's personal Telegram account**.

A Telegram event and a Gmail event discussing the same work item must be able to become one `Topic` and one `Decision`, while the user can inspect the original message from either source.

Collection and state management MUST continue to work if AI is unavailable. Telegram raw or Telegram-derived content MUST NOT enter AI in MVP1.

---

# 1. v0.3 final closure summary

v0.3 is the implementation baseline after the second adversarial review. It preserves the approved MVP1 scope (**Gmail + personal Telegram only**) and closes NB1/NM2/NM3/NM4 plus the associated MINOR findings.

| Review #2 finding | v0.3 disposition |
|---|---|
| NB1: Queue-consumer CPU assumption | **CLOSED conservatively.** The architecture assumes a maximum **10 ms active CPU budget** for a Free-plan Worker consumer until an empirical Free-account probe proves a larger supported limit. `max_batch_size=1` initially; processing is bounded/I/O-dominant. Correctness does not depend on 30s/5m. Host-side HTTP pull is the pre-approved fallback if the empirical budget is inadequate. |
| NM2: enum/aggregate/existential Telegram leakage into AI | **CLOSED constructively.** MVP1 AI is **Gmail-source-local and pre-aggregation only**. AI accepts only `GmailEvidenceBundle`; it cannot read Topic/Stream/Person/shared state. Cross-channel merge happens only after Gmail AI enrichment and is never fed back to AI in MVP1. |
| NM3: gate-manifest self-reference | **CLOSED.** Gate manifests are operator-owned policy-sensitive artifacts. Claude cannot approve/change the binding manifest; CI validates its hash against operator-controlled protected state. |
| NM4: reconciler poison loop | **CLOSED.** Terminal `FAILED/DLQ` items are excluded from reconciliation; bounded attempt count transitions poison items once to DLQ; a mandatory resilience test proves no loop. |
| MIN-1 routing hints | **CLOSED.** Every content-derived routing hint is a provenance-bearing value. |
| MIN-2 TDLib first-login cache | **CLOSED.** Initial local TDLib synchronization is allowed as client behavior, but central event emission is bounded by `connected_at`; older cache content is not emitted as new events. |
| MIN-3 iOS standalone Access | **CLOSED in DoD.** Install/login/re-login is tested in standalone Home Screen mode on a real iPhone. |
| MIN-4 ADR-007 auth chain | **CLOSED.** Full browser -> Worker -> Access/service identity -> Tunnel -> Content Gateway authentication chain is specified. |
| MIN-5 Analytics limits | **CLOSED as live-verification duty.** Published Free limits are recorded but must be re-fetched in G2. |
| MIN-6 timestamps | **CLOSED.** Source timestamps and any derived temporal values carry provenance when used outside source-local transport bookkeeping. |
| MIN-7 push timing | **ACCEPTED residual INFO.** Push remains opaque; infrastructure necessarily observes notification timing. |
| Queue storm/free cap | **CLOSED.** Soft dispatch budget + durable outbox degradation prevents surprise billing or event loss. |

The Cloudflare documentation is internally ambiguous on Queue consumer CPU: the Workers Free table says 10 ms CPU per invocation, while the Queues limits page also describes a 30s default / configurable 5m consumer limit and says most queue limits apply to Free. v0.3 deliberately does **not** depend on the larger interpretation.

Implementation may start at **G0 only** after operator GO. Later gates remain individually governed; this document is not a blanket authorization to implement/merge all gates.

---

# 2. Product goals

The target product SHALL provide:

1. Automatic near-real-time intake of new communication events.
2. One prioritized `Today / Decisions / Actions` surface.
3. Cross-channel aggregation into one topic where evidence supports the merge.
4. Person, project and workstream state.
5. Progress and meaningful state changes per stream.
6. Commitments: waiting for me / waiting for another person / overdue / done.
7. Basic milestones and ETA state.
8. Centralized intermediate knowledge and deliverable references.
9. Navigation: Project -> Stream -> Topic/Intent -> Knowledge -> Decision -> Evidence.
10. Proactive alerts for stale decisions, approaching deadlines and overdue commitments.
11. Full evidence drill-down to source content.
12. Push notifications generated from actionable state changes, not raw unread count.
13. Android PWA support.
14. iPhone Home Screen PWA support.
15. Browser/Web support.
16. No required desktop client.
17. Hard-zero cost mode that fails closed instead of silently buying quota.

---

# 3. MVP1 approved scope lock

MVP1 source scope is exactly:

```text
Gmail
Personal Telegram account
```

No other communication source is permitted to become an MVP1 dependency.

Explicitly POST-MVP:

```text
Outlook / Microsoft 365
Slack
WhatsApp
Signal
LinkedIn
Instagram / Facebook Messenger
X
Discord
Google Messages / SMS
Google Chat
Notion
Jira
GitHub
calendar write actions
native iOS / Android applications
```

A later source may have design placeholders or interfaces, but no implementation gate may pull it into MVP1 without an operator-approved scope revision.

---

# 4. MVP1 non-goals

MVP1 does NOT:

- replace Telegram or Gmail as full messaging clients;
- import the user's whole historical Telegram account;
- train/fine-tune/benchmark a model on communication content;
- run LLMs, embeddings or other ML over raw or derived Telegram content;
- make autonomous external decisions;
- send external replies autonomously;
- become a commercial multi-tenant SaaS;
- build a full project management suite;
- promise perfect semantic Telegram understanding;
- build Matrix/mautrix infrastructure;
- require Beeper, Beeper Plus or Beeper Desktop;
- depend on desktop availability for normal operation.

---

# 5. Architecture invariants

The following are non-negotiable without ADR + independent review + operator approval:

```text
INV-01 Collector works without AI.
INV-02 MVP1 sources are Gmail + Telegram only.
INV-03 Raw Telegram content never enters AI.
INV-04 Any value or assignment derived from Telegram content inherits Telegram provenance/taint, regardless of datatype.
INV-05 MVP1 AI accepts Gmail-source-local evidence only; shared Topic/Stream/Person/cross-channel state is not an AI input.
INV-06 Every decision/action/commitment/milestone claim has evidence provenance.
INV-07 UNKNOWN is preferable to fabricated certainty.
INV-08 Processing is idempotent.
INV-09 Queue is transport, never source of truth.
INV-10 Accepted-but-unprocessed events are reconciled independently of queue retention.
INV-11 Push transport contains no source-derived content.
INV-12 Raw message bodies never enter application logs, metrics, audit, queue payloads or CI fixtures.
INV-13 User can drill down to original evidence when the source remains available.
INV-14 Telegram raw content is not stored in central Decision DB by default.
INV-15 Topic and identity merges are reversible and audited.
INV-16 Events assigned to different confirmed projects cannot auto-merge.
INV-17 Free quota exhaustion degrades service; it never creates surprise billing.
INV-18 Desktop is not required for normal use.
INV-19 Retention is source-aware and provenance-aware.
INV-20 Implementer cannot approve or merge own gate.
INV-21 No gate closes without applicable DoD.
INV-22 Unknown/mixed source policy fails closed.
INV-23 Connector protocol details do not leak into core domain services.
INV-24 AI has no direct connector/tool credentials.
INV-25 Source content is data, never trusted instruction.
INV-26 Cross-channel Topic/Decision state is never fed back into AI in MVP1.
INV-27 Queue Worker correctness must fit a conservative 10 ms active-CPU budget unless an empirical Free-account probe proves otherwise.
INV-28 Gate manifests and their approved hashes are operator-owned protected governance state.
INV-29 Terminal FAILED/DLQ events are never automatically reconciled back into the processing queue.
INV-30 Telegram full-content drill-down uses application-layer encryption end-to-end between Content Gateway and PWA.
INV-31 Opaque push timing is an accepted residual metadata side-channel; push content remains opaque.
```

---

# 6. Telegram contractual/compliance boundary

Current Telegram API Terms state that data obtained from Telegram may not be used/accessed/aggregated to train, fine-tune or otherwise engage in development, enhancement or deployment of AI/ML systems. Telegram Content Licensing terms separately limit access to ordinary legitimate use and provide a limited exception for legitimate Telegram clients.

MVP1 takes the conservative position already reached by prior review:

```text
Telegram realtime client receive         ALLOWED DESIGN PATH
Telegram normal display                  ALLOWED DESIGN PATH
Telegram on-demand original drill-down   ALLOWED DESIGN PATH
Telegram deterministic routing           PERMITTED DESIGN ASSUMPTION; revalidate at G0 and periodic policy review
Telegram raw → LLM                       FORBIDDEN
Telegram raw → embeddings                FORBIDDEN
Telegram-derived values → LLM            FORBIDDEN
Telegram-derived values in AI prompts    FORBIDDEN
Telegram historical AI index             FORBIDDEN
```

The architecture does not claim that realtime data is exempt from Telegram's AI terms merely because it is realtime. Realtime vs bulk affects privacy/minimization and product design, not the literal AI restriction.

G0 MUST re-fetch and review the current Telegram terms before implementation GO. Changes in terms require a policy review.

---

# 7. Value-level provenance, assignment provenance and AI isolation

Every value **and every semantic assignment caused by source content** is provenance-bearing. Datatype is irrelevant.

Logical wrapper:

```text
ProvenanceValue<T>
  value
  provenance[]
  derivation_method
  ai_policy
  sensitivity
  created_at
  derivation_version
```

Examples that remain Telegram-tainted:

```text
"Gate 4.2"                       string extracted from Telegram
14500                             number extracted from Telegram
2026-09-11T17:00Z                datetime parsed from Telegram
true                              boolean inferred from Telegram
"Alex Petrov"                    source display name from Telegram
IntentClass.DECISION_REQUIRED     enum assignment triggered by Telegram content
TopicAssignment(topic=T1)         assignment triggered by Telegram evidence
count=3                           aggregate if one counted item is Telegram-derived
```

A system constant is not content-derived by itself:

```text
Source.TELEGRAM
State.OPEN
IntentClass.DECISION_REQUIRED     enum definition only
project_id configured manually by operator
```

But **an assignment of a constant because of source content carries the source provenance**.

The provenance graph is a DAG:

```text
SourceEvent
    ↓
ProvenanceValue / ProvenanceAssignment
    ↓
SourceEnrichment
    ↓
TopicAssignment / DecisionEvidence
    ↓
Decision / Commitment / Milestone
```

The system MUST answer:

```text
Why does this value/assignment exist?
Which source evidence caused it?
Does any ancestor have AI_DENY provenance?
```

## 7.1 MVP1 AI boundary - source-local before aggregation

MVP1 eliminates the ambiguous enum/aggregate/membership leakage path by construction.

The only AI input type is:

```text
GmailEvidenceBundle
```

It may contain only Gmail evidence fetched from a Gmail account whose source policy allows AI. It MUST NOT contain:

```text
Topic
Stream
Person shared/cross-source attributes
cross-channel participants
cross-channel event counts
cross-channel updated_at/occurred_at aggregates
Telegram-derived routing hints
Telegram-derived enums/states
Telegram-derived project/topic assignments
any shared object whose existence/membership was influenced by Telegram
```

Processing order is mandatory:

```text
Gmail raw event
   ↓
Gmail-only normalization / GmailEvidenceBundle
   ↓
AI structured extraction (optional)
   ↓
GmailSourceEnrichment  [Gmail provenance only]
   ↓
DETERMINISTIC cross-channel resolver
   ↑
Telegram deterministic SourceEnrichment
```

After the resolver combines Gmail and Telegram into a Topic/Decision, **that combined state is never sent back to AI in MVP1**.

Therefore there is no cross-channel membership-selection feedback into the AI context. A future cross-channel AI summary/recommendation is POST-MVP and requires a new source-policy/compliance review.

## 7.2 Composition rule

Generic AI serialization still fails closed:

```text
ai_safe(value) = all provenance ancestors are AI_ALLOW
```

Unknown/mixed ancestry = `AI_DENY`.

Mandatory automated test:

```text
No Telegram-provenance value or assignment can be serialized into any AI request.
No Topic/Stream/Person/shared-state object can be passed to MVP1 AI serializer.
```

---

# 8. Canonical state versus display projections

To prevent source-derived text from leaking through shared topic fields, canonical domain state separates machine identity from display values.

Example:

```text
Topic
  id = UUID
  project_id = user-configured opaque ID
  stream_id = user-configured opaque ID
  topic_key = project-scoped opaque/normalized key
  state = OPEN
  intent_class = DECISION_REQUIRED
```

Display information is separately provenance-bearing:

```text
TopicDisplay
  title: DerivedValue<string>
  subtitle: DerivedValue<string>
```

If a title was extracted from Telegram, it can be displayed to the user after authenticated fetch but MUST NOT be included in AI context or push payload.

A Gmail-derived title may be AI-eligible if its provenance policy allows it.

---

# 9. Target architecture

```text
                     SOURCE PLANE

 Personal Telegram                         Gmail
       │                                      │
       ▼                                      ▼
 direct TDLib listener                Gmail API collector
 always-on connector host             cloud control plane
       │                                      │
 deterministic parser                        AI optional
       │                                      │
       └──────────────┬───────────────────────┘
                      ▼
               INGEST GATEWAY
                      │
               Durable Ingest
                      │
                     D1
                      │
                    Outbox
                      │
              Cloudflare Queue
                      │
               Queue Consumer
                      │
       ┌──────────────┼─────────────────┐
       ▼              ▼                 ▼
   Identity       Project/Stream     Topic Resolver
       └──────────────┬─────────────────┘
                      ▼
              Operational State
        Intent / Decision / Commitment
        Milestone / Knowledge Reference
                      │
               Priority Engine
                      │
             Notification State
                      │
                OPAQUE WEB PUSH
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
      Android PWA             iPhone PWA
                \             /
                   Web/PWA
                      │
            authenticated drill-down
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
      Gmail API             Telegram Content Gateway
                                  │
                           Cloudflare Tunnel
                                  │
                           connector host/TDLib
```

---

# 10. Deployment topology

## 10.1 Cloud control plane

MVP1 control plane:

```text
Cloudflare Pages / Workers Static Assets
Cloudflare Workers API
Cloudflare D1
Cloudflare Queues
Cloudflare R2
Cloudflare Access or equivalent private auth boundary
Workers Analytics Engine
Workers AI (Gmail only, optional and policy-controlled)
Web Push
```

## 10.2 Telegram connector host

Telegram requires a persistent client process and MUST NOT depend on stateless Workers.

Preferred host order:

```text
1. Already-owned always-on mini-PC / server / Raspberry Pi
2. Reliable free VM if available
3. Existing home/NAS server
4. Normal desktop PC only as development/last-resort fallback
```

MVP1 cost target assumes an already-owned or genuinely free always-on host.

## 10.3 NAT/reverse access decision

MVP1 chooses **Cloudflare Tunnel**.

The connector host runs `cloudflared` and initiates an outbound-only tunnel. No inbound port or public IP is required.

ADR required:

```text
ADR-007 Connector Content Gateway via Cloudflare Tunnel
```

No alternative reverse-channel implementation is allowed in MVP1 without revising this ADR.

---

# 11. Telegram connector - direct TDLib

MVP1 uses direct TDLib rather than Matrix/mautrix.

Responsibilities:

```text
authenticate personal Telegram account
hold persistent Telegram session
receive new updates
recover after disconnect using Telegram/TDLib synchronization
expose connector health
perform deterministic pattern extraction
emit minimal normalized metadata
serve original source content on authenticated demand
build best-effort deep links
```

No historical bulk backfill is performed when the source is first connected.

The adapter starts at connection activation time and tracks:

```text
connected_at
last_update_at
last_local_checkpoint
health_state
```

Version pinning:

```text
TDLib version pinned
binary/source checksum recorded
upgrade requires connector gate
```

### 11.1 Telegram deterministic parser

Allowed techniques in MVP1 are intentionally narrow:

```text
known-chat mappings
known-user mappings
exact/normalized identifier extraction
regex
fixed dictionaries / phrase families
explicit dates/times
explicit amounts
reply/thread relationships exposed by source
user-configured project/stream rules
```

No embeddings, neural classifier or semantic model.

Examples of pattern classes:

```text
APPROVAL_REQUEST
DEADLINE_EXPLICIT
BLOCKER_EXPLICIT
WAITING_FOR_USER
DELIVERABLE_MENTION
BUSINESS_IDENTIFIER
```

Every derived value inherits Telegram provenance.

---

# 12. Gmail connector

Primary mode:

```text
Gmail users.watch
  ↓
Google Pub/Sub push
  ↓
authenticated Cloudflare endpoint
  ↓
history.list incremental recovery
```

The connector MUST renew `watch` daily or otherwise comfortably before expiration.

Google Pub/Sub push authentication MUST be verified using the configured OIDC/JWT identity and audience. Unsigned/unexpected pushes are rejected.

State:

```text
gmail_account_id
connected_at
watch_expiration
last_history_id
last_successful_sync_at
last_seen_internal_date
gap_state
```

### 12.1 No-backfill versus gap-recovery

These are separate concepts.

```text
PRE_CONNECTION_BACKFILL = OFF
POST_CONNECTION_GAP_RECOVERY = REQUIRED
```

If `history.list` reports an expired/invalid history cursor, the connector performs bounded recovery for the missing period beginning no earlier than `connected_at` / last confirmed synchronized time.

Recovery may use `messages.list`/`messages.get` for the known gap window and relies on central idempotency to remove duplicates.

The connector MUST never silently import messages older than the source activation boundary merely because history recovery failed.

### 12.2 Hard-zero Gmail fallback

G0/G3 MUST verify whether the desired Pub/Sub configuration requires a billing account even at $0 usage.

If the operator refuses any billing-account attachment, MVP1 MAY switch by explicit configuration to:

```text
GMAIL_COLLECTION_MODE=POLL
```

with automatic periodic incremental polling. This is still automatic collection but may have lower freshness. It is not a hidden fallback; the mode is displayed in OPS.

---

# 13. Normalized event contract

All sources emit one connector-neutral envelope. Any content-derived hint inside it uses a provenance-bearing wrapper.

```json
{
  "event_id": "uuid",
  "source": "telegram|gmail",
  "source_account_id": "...",
  "source_event_id": "provider-id",
  "source_thread_id": "provider-thread-id-or-null",
  "event_type": "MESSAGE_CREATED|MESSAGE_UPDATED|MESSAGE_DELETED",
  "direction": "INBOUND|OUTBOUND",
  "occurred_at": "...",
  "received_at": "...",
  "content_locator": {
    "kind": "SOURCE_REF",
    "ref": "opaque-source-ref"
  },
  "routing_hints": [
    {
      "value": "ERP::Gate-4.2",
      "provenance": ["source-event-id"],
      "derivation_method": "RULE|STATIC_CONFIG|PROVIDER_METADATA",
      "ai_policy": "ALLOW|DENY"
    }
  ],
  "source_policy_id": "...",
  "trace_id": "...",
  "schema_version": 3
}
```

Raw Telegram body is NOT part of the central event contract.

For Gmail, raw bodies are also not persisted by default in D1; source content is fetched only for Gmail-source-local processing or authenticated user drill-down.

Provider `occurred_at` is source provenance. Central `received_at` is transport bookkeeping; if it is later used to derive business meaning (for example urgency or temporal correlation), that derived value/assignment carries the relevant event provenance.

---

# 14. Durable ingest contract

An event is considered **accepted** only after it is persisted centrally.

```text
Source/Connector
   ↓
POST /ingest
   ↓
authenticate + validate + dedupe key
   ↓
D1 transaction
  ingest_event = ACCEPTED
  outbox        = PENDING
   ↓
ACK source
```

Idempotency key:

```text
(source_account_id, source_event_id, event_type, source_version_if_needed)
```

Duplicate accepted submissions return success without creating a second logical event.

---

# 15. Connector local spool

Telegram connector maintains a local SQLite WAL spool for outbound normalized events until central ACK.

State:

```text
PENDING
ACKED
FAILED_RETRYABLE
FAILED_PERMANENT
```

The local spool contains the minimum event metadata required to retry; it does not become an independent indefinite raw Telegram archive.

Durability:

```text
transactional write before network send
fsync/WAL checkpoint policy documented
retry with exponential backoff + jitter
```

Known residual risk:

```text
catastrophic loss of the connector-host disk before central ACK may lose events not recoverable from source history.
```

TDLib reconnect/source-difference recovery MUST be tested to reduce this risk.

---

# 16. Queue and processing architecture

Cloudflare Queue is transport only. D1 durable ingest/outbox remains source of truth.

MVP1 uses one primary queue:

```text
event-pipeline
```

Queue payload:

```json
{
  "event_id": "uuid",
  "operation": "PROCESS_EVENT",
  "schema_version": 3
}
```

No source body or source-derived display text is placed in Queue.

## 16.1 Conservative Free-plan CPU rule

Cloudflare's official documentation is currently ambiguous: the Workers Free limits table states 10 ms active CPU per invocation, while the Queues limits page also describes a 30-second default / configurable 5-minute consumer limit and states most Queue limits apply to both Free and Paid. MVP1 therefore uses the stricter interpretation as the architectural budget:

```text
HTTP Worker target active CPU      <= 8 ms p95 in quota harness
Queue consumer target active CPU   <= 8 ms p95 in quota harness
Assumed hard design ceiling        10 ms active CPU/invocation
initial max_batch_size             1 event
```

Waiting on D1/Gmail/Workers-AI/network I/O is not counted as active CPU by Workers, but CPU spent parsing, scoring and serialization is bounded explicitly.

The Queue consumer MUST perform only bounded work:

```text
fetch event by indexed primary key
fetch <= MAX_TOPIC_CANDIDATES (default 20) using indexed query
bounded deterministic score
small schema validation
state transition writes
I/O calls to source/AI only where policy permits
```

No unbounded scans, large in-memory corpora, compression, bulk export or batch semantic processing is allowed in the consumer.

G0/G2 must run an empirical smoke/profiling harness on the actual Free account. If the real supported Queue-consumer CPU budget is larger, that is extra margin only; architecture does not rely on it.

## 16.2 Pre-approved runtime fallback

If empirical testing shows the Worker consumer cannot maintain adequate margin under the 10 ms conservative budget, the queue consumer may be switched to Cloudflare's documented **HTTP pull consumer** on the already-required connector host. This keeps the same queue and event contracts and moves CPU-heavy processing outside Workers.

Such a switch requires ADR-011 to record the runtime choice but does not change MVP1 functional scope.

## 16.3 Free Queue operation protection

Free Queues currently include 10,000 operations/day with 24-hour retention. A normal message commonly consumes write + read + delete operations.

MVP1 soft guardrail:

```text
MAX_DISPATCHED_QUEUE_MESSAGES_PER_DAY = 2500  (configurable downward only without review)
```

At/near the guardrail:

```text
new events continue to be durably accepted in D1
outbox remains PENDING
Queue dispatch pauses
OPS shows HARD_ZERO_DEGRADED_QUEUE_BUDGET
processing resumes after budget reset/reconciliation
no paid upgrade is triggered automatically
```

The guardrail preserves margin for retries, DLQ handling and reconciliation.

---

# 17. Outbox, retry, queue-expiry reconciliation and poison-event termination

A Queue write does not prove eventual processing because Free retention is finite.

Event state:

```text
ACCEPTED
PROCESSING
PROCESSED
RETRYABLE_FAILED
DLQ
```

Outbox state:

```text
PENDING
DISPATCHED
RETRY_PENDING
BUDGET_DEFERRED
```

A scheduled **Processing Reconciler** queries only non-terminal accepted work using indexed state/time fields:

```text
state IN (ACCEPTED, RETRYABLE_FAILED)
AND next_attempt_at <= now
AND attempt_count < MAX_PROCESSING_ATTEMPTS
```

It MUST exclude:

```text
PROCESSED
DLQ
permanent/non-retryable failure
```

Default:

```text
MAX_PROCESSING_ATTEMPTS = 5
```

When the attempt cap is reached:

```text
single atomic transition -> DLQ
no automatic re-enqueue thereafter
operator/manual remediation required
```

This remains true even if the old outbox row says `DISPATCHED`.

Mandatory resilience cases:

```text
queue message expires after simulated >24h outage
→ reconciler re-enqueues
→ event eventually PROCESSED
→ no duplicate domain state

poison event fails repeatedly
→ attempt_count reaches cap
→ exactly one terminal DLQ state
→ reconciler never re-enqueues it again
→ Queue operation usage stops increasing for that event
```

Queue-budget deferral is not failure: `BUDGET_DEFERRED` work becomes eligible after the next free-quota window.

---

# 18. Dead-letter handling

Permanent failures create structured dead-letter records without raw content:

```text
event_id
error_class
error_code
processor_version
attempt_count
first_failed_at
last_failed_at
trace_id
```

DLQ is operational evidence, not silent storage.

Operational policy:

```text
DLQ count > 0 => OPS RED
P0 accepted-event processing failure => operator-visible incident
```

Runbook: `docs/runbooks/DLQ.md`.

---

# 19. Identity graph

Canonical `Person` is channel-neutral.

```text
Person P1
  identities:
    Telegram identity T123
    Gmail identity alex@example.com
```

Identity fields retain source provenance.

A Telegram-derived display name may be shown to the user but is excluded from AI context.

Merge states:

```text
CONFIRMED
SUGGESTED
REJECTED
```

No uncertain identity merge is irreversible.

Automatic identity merge in MVP1 requires deterministic evidence stronger than name similarity, such as an operator-confirmed mapping.

---

# 20. Projects, streams and safe identifiers

Project/stream configuration is user-owned application configuration and may therefore be used by both source paths.

Example:

```text
Project: ERP
project_id: prj-erp

Stream: Gate 4.2 rollout
stream_id: str-erp-release-42
```

Business identifiers MUST be namespaced:

```text
ERP::Gate-4.2
Tender::Gate-4.2
```

A naked `Gate-4.2` is not globally unique.

Confirmed project conflict is a hard merge barrier:

```text
project A != project B
AND both assignments confirmed
=> AUTO_MERGE FORBIDDEN
```

---

# 21. Project/stream resolver

Resolution order:

```text
1. user-configured explicit mapping
2. known source chat/thread mapping
3. project-scoped business identifier
4. confirmed identity association
5. deterministic source-specific rules
6. Gmail AI classification if policy permits
7. UNKNOWN
```

`UNKNOWN` is a first-class result.

The resolver MUST never invent a project merely to reduce unknown counts.

---

# 22. Cross-channel Topic Resolver

The core MVP1 hypothesis is:

```text
Telegram event + Gmail event
            ↓
        one Topic
```

The merge decision is deterministic at the cross-source boundary.

Candidate signals:

```text
same confirmed project                      strong
same project-scoped explicit identifier     strong
same user-confirmed person                  medium
same known stream                           strong
source thread/reply relation                 source-local only
same deterministic intent class             weak
close time window                            weak
```

No Telegram semantic similarity is used.

Suggested v0.3 scoring is configuration, not immutable logic:

```text
same confirmed project               +0.25
same confirmed stream                +0.25
same namespaced business identifier  +0.35
same confirmed participant           +0.05
same intent class                    +0.05
time proximity                       +0.05
```

Hard rules override score:

```text
confirmed different project => no auto-merge
explicit user KEEP_SEPARATE => no auto-merge
explicit user MERGE => merge + audit
```

Thresholds initially:

```text
>=0.90 AUTO_ATTACH
0.70-0.89 CANDIDATE_MERGE
<0.70 SEPARATE
```

The thresholds are calibrated in Shadow evaluation.

### 22.1 Accepted recall limitation

Because Telegram semantic ML is intentionally disabled, messages without shared deterministic identifiers may fail to merge with related Gmail content.

This is an accepted compliance-driven MVP1 trade-off.

Quality gating therefore evaluates:

```text
precision across all auto-merges
recall across deterministically linkable test cases
```

Overall semantic Telegram merge recall is tracked but is not allowed to force prohibited AI use.

---

# 23. Intent engine

Minimum MVP1 intent classes:

```text
DECISION_REQUIRED
ACTION_REQUIRED
WAITING_FOR_ME
WAITING_FOR_OTHER
BLOCKER
DEADLINE
DELIVERABLE_RECEIVED
MILESTONE_UPDATE
FYI
UNKNOWN
```

Telegram intent extraction is deterministic and provenance-tainted.

Gmail may use AI structured extraction if source policy allows it.

The final intent object retains all supporting evidence IDs.

---

# 24. Gmail AI architecture - source-local, pre-aggregation only

AI is optional and provider-abstracted:

```text
AIProvider
  WorkersAIProvider
  NoAIProvider
  future LocalProvider
```

No domain service imports a provider SDK directly.

## 24.1 Only accepted AI input type

MVP1 AI entry point accepts exactly:

```text
GmailEvidenceBundle
```

`GmailEvidenceBundle` is produced from Gmail source evidence **before** cross-channel topic resolution and contains only Gmail-origin material allowed by the Gmail source policy.

Compile-time/domain-boundary rule:

```text
AIContextBuilder.build(GmailEvidenceBundle) -> AIRequest
```

There is no overload accepting:

```text
Topic
Stream
Person
Decision
CrossChannelContext
generic DerivedValue[]
```

Runtime `assert_ai_safe()` additionally traverses provenance and fails closed.

`AIContextBuilder`:

1. accepts only Gmail source-local evidence;
2. verifies Gmail account/source policy permits AI;
3. traverses all value provenance;
4. rejects mixed/unknown/Telegram ancestry;
5. limits content to minimum necessary Gmail evidence;
6. strips quoted-history/boilerplate where deterministic bounded parsing permits;
7. redacts configured secrets;
8. serializes explicit schema;
9. records AI run metadata without raw body in application logs.

AI output MUST pass JSON Schema and becomes:

```text
GmailSourceEnrichment
```

with Gmail-only provenance.

Only after this step does the deterministic cross-channel resolver combine Gmail enrichment with Telegram deterministic enrichment.

## 24.2 No combined-topic AI in MVP1

The following are explicitly POST-MVP:

```text
AI summary of a Gmail+Telegram Topic
AI recommendation using combined cross-channel evidence
AI prompt selected/expanded based on Telegram membership
AI rewriting of Telegram-derived topic title
```

MVP1 may display a combined decision supported by evidence from both sources, but any AI-authored field is labelled/traceable as **Gmail-evidence-only**. Cross-channel recommendation logic, if any, is deterministic only.

---

# 25. Workers AI data-use position

As of the v0.3 verification date, Cloudflare documents that Workers AI Customer Content is not used to train models made available on Workers AI and is not used to improve Cloudflare or third-party services without explicit consent.

This does NOT remove the requirement to review:

```text
selected model license
selected model provider terms
retention/privacy configuration
source-specific permission to submit Gmail content
```

G0 records the chosen model and terms snapshot in an ADR before production Gmail content is sent to AI.

AI may be disabled entirely; the system must still operate.

---

# 26. Decision model

```text
Decision
  id
  topic_id
  question/value projection with provenance
  state
  owner
  due_at with provenance
  priority
  options[]
  recommendation optional
  evidence[]
  created_at
  updated_at
  resolved_at
```

States:

```text
OPEN
NEEDS_REVIEW
SNOOZED
RESOLVED
CANCELLED
```

In MVP1 an AI-authored recommendation, if enabled at all, is created only inside the Gmail source-local enrichment step and therefore may use **Gmail evidence only**. It is stored with explicit Gmail-only provenance and MUST NOT be recomputed, expanded or justified using the combined Gmail+Telegram Topic.

A Telegram event may contribute to the existence/state of a decision through deterministic logic, but Telegram-derived values, shared topic state and combined evidence are never fed back into AI.

---

# 27. Commitments

Commitment model:

```text
Commitment
  actor
  counterparty
  action
  due_at
  state
  evidence
  provenance
```

States:

```text
OPEN
DUE_SOON
OVERDUE
DONE
CANCELLED
```

MVP1 supports explicit/deterministically detectable commitments from Telegram and AI/deterministic extraction from Gmail.

---

# 28. Minimal milestones, ETA and progress in MVP1

Milestones remain in MVP1 but are intentionally minimal because progress/ETA was explicitly requested as part of the product concept.

```text
Milestone
  stream_id
  title/projection
  owner
  planned_at
  forecast_at
  state
  evidence
```

No sophisticated AI forecasting in MVP1.

Forecast sources:

```text
MANUAL
RULE_DERIVED
GMAIL_AI_SUGGESTED
```

Progress is based on explicit task/milestone state, not invented LLM percentages.

If numeric progress is not defensible, show categorical state.

---

# 29. Knowledge and deliverables

MVP1 knowledge is deliberately link/reference oriented.

Types:

```text
FACT
DECISION
DELIVERABLE_REF
USER_NOTE
SOURCE_REF
MILESTONE
COMMITMENT
RISK
```

Telegram raw text is not automatically copied into durable Knowledge Items.

The user can retain a source reference or write a new personal note.

A user-authored note has its own provenance and is not automatically treated as a transformed copy of Telegram content; the UI must not silently auto-generate such notes from Telegram text.

---

# 30. Priority Engine

Final priority is deterministic and explainable.

Illustrative configurable weights:

```text
+40 deadline <24h
+30 direct decision request
+25 blocker
+20 explicitly waiting for user
+15 overdue
+10 repeated follow-up
+10 milestone at risk
-20 FYI
-30 resolved
```

Priority classes:

```text
P0 critical
P1 high
P2 normal
P3 low
```

The UI exposes `Why priority?` with evidence-safe explanations.

No Telegram-derived text is required to be included in the explanation; generic rule labels may be used.

---

# 31. Proactive Management Engine

Runs on structured operational state, not full rereading of all messages.

Rules:

```text
open decision due soon
overdue commitment
waiting-on-other past threshold
stream stale past threshold
milestone forecast after planned date
required deliverable missing
unprocessed accepted event
connector stale
```

Outputs `ProactiveAlert` with evidence references.

---

# 32. Push architecture - opaque only

v0.1's content-bearing notification design is removed.

Push payload MUST contain no source-derived content.

Allowed example:

```json
{
  "type": "STATE_CHANGED",
  "notification_id": "n-123",
  "schema_version": 1
}
```

Not allowed in push transport:

```text
sender name
message excerpt
topic title
decision question
source-derived deadline
project label if derived from source
source content
```

The client wakes and performs an authenticated state fetch.

Push is an optimization, not source of truth.

If push is delayed/lost, opening/resuming the PWA performs state sync and the Today screen becomes correct.

For MVP1, generic local notification text MAY be:

```text
Personal Decision OS has new updates.
```

No claim of guaranteed Web Push delivery is made.

---

# 33. Full-content drill-down and Content Gateway security

The user MUST be able to inspect original Gmail or Telegram content when the provider/source still exposes it.

Central Decision DB stores source references, not Telegram raw bodies.

## 33.1 Gmail

```text
PWA
 ↓ authenticated request
API / Gmail source adapter
 ↓ Gmail API
message body/thread
 ↓
PWA
```

Raw Gmail responses use `Cache-Control: no-store`; service-worker caching is forbidden.

## 33.2 Telegram - fixed Cloudflare Tunnel path

```text
PWA
 ↓ authenticated application session
Cloudflare Worker / content request broker
 ↓ service-authenticated request
Cloudflare Access + Cloudflare Tunnel
 ↓
Telegram Content Gateway on connector host
 ↓ TDLib local/source fetch
original Telegram content
 ↓ application-layer encrypted envelope
Cloudflare path carries ciphertext only
 ↓
PWA decrypts locally
```

Cloudflare Tunnel is outbound-only from the connector host; no inbound port/public origin IP is required.

## 33.3 Mandatory application-layer encryption for Telegram drill-down

v0.3 chooses former option A. This is not optional in MVP1.

Envelope design:

```text
PWA creates ephemeral WebCrypto P-256 ECDH key pair per authenticated content session
Gateway has operator-provisioned rotating P-256 ECDH key pair
PWA sends ephemeral public key + one-time request nonce
Gateway derives shared secret using ECDH
HKDF-SHA256 derives AES-256-GCM content key
Gateway encrypts raw Telegram body + authenticated metadata
Worker/Tunnel transports ciphertext only
PWA derives same key and decrypts locally
```

Requirements:

```text
fresh nonce per content request
short expiry (default <=60s)
AES-GCM associated data binds request_id/source_ref/schema_version
replay rejected
Gateway public key pinned via authenticated application configuration
key_id supports rotation
plaintext never logged/cached by Worker/Tunnel application code
```

## 33.4 Full authentication chain (ADR-007 binding decision)

```text
1. User authenticates to PWA/API via Cloudflare Access-approved identity.
2. Worker verifies application session/Access identity and authorization to the requested source_ref.
3. Worker creates a one-time signed ContentRequest:
   request_id, source_ref, client_ephemeral_pubkey, expires_at, nonce.
4. Worker authenticates to the Tunnel-protected Content Gateway with an operator-controlled Cloudflare Access service token AND application request signature/HMAC.
5. cloudflared transports the request over outbound Tunnel to localhost Content Gateway.
6. Gateway validates service identity/signature, expiry, nonce and source_ref policy before TDLib access.
7. Gateway fetches the source content, encrypts it to the PWA ephemeral key, and returns ciphertext.
8. Worker passes ciphertext without decryption.
9. PWA decrypts locally and renders plain text safely.
```

No alternate unauthenticated direct-to-host route is permitted.

---

# 34. Core data model

Minimum D1 tables:

```text
users
devices
source_accounts
source_policies
source_cursors

ingest_events
processing_outbox
processing_attempts
dead_letter_events

people
identities

projects
streams
topics
topic_events
topic_merge_events

intents
decisions
decision_evidence
commitments
milestones
knowledge_items
deliverables

notifications
snoozes

ai_runs
policy_decisions

audit_events
backup_runs
retention_runs
```

Content-bearing fields MUST use provenance-aware wrappers or equivalent normalized provenance tables; plain untracked free-text domain columns are forbidden for source-derived values.

---

# 35. D1 design and quota budget

Current Free limits must be treated as hard constraints:

```text
5M rows read/day
100K rows written/day
500 MB maximum per Free database
5 GB total account storage
7-day Time Travel
```

Beginning 2026-09-01, exceeding daily read/write limits causes D1 queries to fail until reset.

Requirements:

```text
indexes in migration 001
no growing-table full scan in hot path
query plan review for topic candidate selection
pagination for exports
quota counters visible in OPS
```

Mandatory gate budget test simulates at least:

```text
200 events/day normal
1000 events/day stress
```

and records actual/estimated:

```text
D1 writes/event
D1 reads/event
Queue ops/event
Analytics datapoints/event
HTTP requests/event
```

---

# 36. Operational metrics storage

Do not write one D1 row per low-level telemetry observation.

Use:

```text
D1 -> authoritative domain/operational state
Workers Analytics Engine -> high-volume metrics where appropriate
Cloudflare native metrics -> platform telemetry
```

Analytics Engine Free is also capped; as of v0.3 verification its published allowance is 100,000 data points/day and 10,000 read queries/day. It must not be described as unlimited.

---

# 37. Security threat model

Threats include:

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
```

---

# 38. Authentication and authorization

MVP1 is private/single-user.

Requirements:

```text
no public signup
explicit operator identity only
short-lived authenticated browser session
re-authentication for sensitive configuration changes
separate connector-host service identity
least-privilege route authorization
```

Production credentials are held by operator-controlled systems, not Claude implementation context.

---

# 39. Gmail OAuth/token security

Use Authorization Code + PKCE where applicable.

Refresh token storage:

```text
encrypted record in D1 or dedicated protected store
AES-256-GCM
key-encryption secret stored outside D1 as Worker Secret
```

Tokens:

```text
never client-readable
never logged
never in URLs
revocable
least privilege
```

Gmail should remain entirely in the cloud control plane; it does not require the Telegram connector host.

---

# 40. Telegram session security

TDLib session material is high sensitivity.

Requirements:

```text
connector host disk encryption where feasible
root/service-user only permissions
no session material in repo/backups without encryption
session revocation runbook
host compromise => source account incident
```

---

# 41. Connector-to-cloud authentication

Each ingest request includes authenticated connector identity.

Preferred:

```text
mTLS or HMAC request signing
```

If HMAC:

```text
connector_id
timestamp
nonce
body hash
signature
```

Reject:

```text
bad signature
expired timestamp
reused nonce
unknown key version
```

Key rotation is mandatory:

```text
active_key_id
next_key_id
grace overlap
revocation procedure
```

Runbook: `CONNECTOR_KEY_COMPROMISE.md`.

---

# 42. Raw-content security

Raw content MUST NOT enter:

```text
logs
metrics
analytics dimensions
queue payloads
audit records
URLs
push payloads
exception traces
CI fixtures
```

AI-generated user-facing text is rendered as plain text by default, length-limited, with no trusted HTML/Markdown execution.

---

# 43. PWA security

Mandatory controls:

```text
strict CSP
no unsafe-eval
avoid unsafe-inline
HttpOnly/Secure/SameSite cookies where cookies used
CSRF protection
Referrer-Policy
Permissions-Policy
X-Content-Type-Options
input/output encoding
Trusted Types where practical
```

Service Worker MUST NOT cache authenticated message bodies or decrypted Telegram content.

Known residual privacy limitation: operating systems may show app-switcher snapshots. Document as an accepted platform risk and optionally blur sensitive views on visibility change where reliable.

---

# 44. Prompt injection controls

Inbound content is untrusted data.

AI has:

```text
no Gmail OAuth token
no Telegram session
no connector credentials
no direct tools
no policy mutation rights
```

AI result path:

```text
untrusted content
 ↓
AIContextBuilder policy enforcement
 ↓
model
 ↓
JSON schema validation
 ↓
domain validation
 ↓
proposed derived state
```

No source content can instruct the model to bypass provenance or source policy.

Human-facing AI fields:

```text
plain text only
length capped
links disabled unless independently generated/validated by app
source evidence separately shown
```

---

# 45. Audit model

Audit events contain metadata/state hashes, not message bodies.

```text
actor
operation
object_type
object_id
old_state_hash
new_state_hash
trace_id
occurred_at
previous_audit_hash
```

`previous_audit_hash` creates cheap tamper-evident hash chaining.

Audited operations include:

```text
TOPIC_MERGED
TOPIC_SPLIT
IDENTITY_MERGED
DECISION_CREATED
DECISION_RESOLVED
MILESTONE_CHANGED
SOURCE_CONNECTED
SOURCE_DISCONNECTED
POLICY_CHANGED
AI_RUN
RETENTION_RUN
BACKUP_RUN
```

---

# 46. Observability architecture

Three layers:

```text
TECHNICAL HEALTH
PIPELINE CORRECTNESS
PRODUCT QUALITY
```

Required technical metrics:

```text
connector_up
connector_last_event_age
gmail_watch_expiration
source_auth_health

ingest_total
ingest_rejected
duplicate_total
accepted_unprocessed_count
reconcile_reenqueue_total
queue_backlog
queue_oldest_age
dlq_count

api_latency
api_errors
push_send_success
push_send_failure

D1 read/write usage
D1 storage
Analytics Engine usage
Workers requests

backup_age
restore_test_age
retention_last_success

ai_runs
ai_failures
ai_policy_blocks
ai_quota_remaining
```

---

# 47. Tracing and explainability

Every source event receives a `trace_id` at first ingestion.

Propagation:

```text
source
→ connector/spool
→ ingest
→ outbox
→ queue
→ processor
→ resolver
→ topic/decision
→ notification
```

The operator must be able to answer without raw-content logs:

```text
Did this event reach the collector?
Was it accepted?
Was it queued?
Was it processed?
Why did it attach to this topic?
Why did a decision appear?
Why did push not appear?
Did any restricted provenance touch AI?
```

---

# 48. Ops dashboard

Owner-only `/ops`.

Sections:

```text
SOURCE HEALTH
  Telegram state / last update
  Gmail state / watch expiry / gap state

PIPELINE
  events today
  accepted-unprocessed
  duplicates
  reconciled
  queue backlog / oldest
  DLQ

LATENCY
  source-to-accept
  accept-to-process
  process-to-visible

AI
  enabled mode
  calls
  policy blocks
  quota usage

COST/QUOTA
  Workers requests
  HTTP CPU sampling
  D1 reads/writes/storage
  Queue operations
  Analytics datapoints/queries

BACKUP/RETENTION
  last backup
  last restore test
  last retention run

SECURITY
  auth failures
  replay rejects
  policy violations
  source-session incidents
```

---

# 49. Product dashboard

Primary user surfaces:

```text
TODAY
DECISIONS
STREAMS
TOPICS / INTENTS
KNOWLEDGE
SEARCH
```

MVP1 `TODAY` shows prioritized structured actions/decisions, not per-channel unread counts.

Example after authenticated app open:

```text
P1  ERP / Gate 4.2
    Decision required
    Evidence: Telegram + Gmail
    Updated 4m ago

    [OPEN] [SNOOZE]
```

The title displayed may come from a safe user-defined label or a provenance-bearing projection. It is never copied into the push payload.

---

# 50. Reporting

## 50.1 Daily Personal Brief

From structured state:

```text
new decisions
items due today
overdues
waiting for me
waiting for others
new deliverable refs
streams at risk
```

## 50.2 Weekly Management Report

Per project/stream:

```text
progress/state changes
milestones achieved/slipped
current manual/rule forecast
open decisions
open blockers
new deliverables
commitments
next focus
```

## 50.3 Engineering Operations Report

```text
events accepted/processed
loss indicators
duplicates
latency
source uptime
reconciliations
DLQ
quota usage
backup/restore
retention
security incidents
```

## 50.4 Compliance Report

```text
source policy version
Telegram ToS review date
AI policy blocks
any prohibited-context test failures
retention executions
policy changes
```

---

# 51. Retention policy

Retention classes:

```text
R0_TRANSIENT
R1_SHORT
R2_OPERATIONAL
R3_USER_KNOWLEDGE
R4_AUDIT
```

## Telegram

Central raw text:

```text
NOT STORED by default
```

Connector-side TDLib/client cache:

```text
minimum operationally necessary
not backed up as long-term message archive by default
```

Central source refs / routing metadata:

```text
active topic + 30 days after resolution default
```

Long-lived business state may retain generic machine state and evidence refs; any retained Telegram-derived value remains provenance-tainted.

## Gmail

Central raw body:

```text
not stored by default
```

Derived operational state:

```text
active + 180 days default
```

User-promoted knowledge/reference:

```text
until user removes it or policy changes
```

## Audit

```text
365 days default
no raw content
```

Retention periods are configuration with safe maximums and must be reviewable in OPS.

---

# 52. Deletion

User can remove:

```text
source connection
project/stream state
topic
knowledge item
local application state
```

Source disconnect deletes/revokes stored credentials.

Retention jobs are idempotent and produce a structured run report.

The application does not claim to delete the original message from Telegram/Gmail unless an explicit future source action is added.

---

# 53. Backup strategy - execution on connector host

D1 Time Travel is useful short-term recovery but is not the only backup.

Because Workers Free active CPU is tightly constrained and Cloudflare's Queue CPU documentation is ambiguous, bulk export/compression/encryption MUST NOT run inside a Worker.

Nightly metadata backup executes on the always-on connector host:

```text
backup-agent
  ↓ official D1 export API / pinned Wrangler d1 export --remote
D1 SQL export
  ↓ local compress
  ↓ local authenticated encryption
  ↓ R2 upload
  ↓ manifest + checksum
```

The backup agent uses an operator-created, least-privilege Cloudflare API token stored only on the host. Global API keys are forbidden.

D1 export may temporarily affect database availability for larger exports; schedule during the configured low-activity window and expose backup duration/impact in OPS.

Backup retention:

```text
7 daily
4 weekly
3 monthly
```

Telegram raw messages are excluded.

Backup key management:

```text
backup data key/passphrase remains outside R2
operator-held recovery/escrow procedure
RESTORE runbook covers total-device-loss recovery
```

Connector host backup includes only what is required to recover connectors:

```text
configuration
TDLib authentication/session state encrypted
source checkpoints
spool schema/state as appropriate
deployment manifests/config versions
```

It does not intentionally preserve an indefinite Telegram message-history mirror.

A backup is not valid until an isolated restore test succeeds.

---

# 54. Disaster recovery

MVP1 targets:

```text
ordinary transient accepted-event loss: 0 by design
catastrophic metadata RPO: <=24h
manual RTO target: <=4h
```

No enterprise HA claim.

Restore testing is mandatory before MVP1 closure.

Test restore:

```text
restore isolated database
validate migrations/schema
validate row counts
validate critical constraints
open representative Project→Topic→Decision data
produce restore report
```

---

# 55. Repository structure

```text
personal-decision-os/
│
├── CLAUDE.md
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
│
├── .github/
│   ├── CODEOWNERS
│   └── workflows/
│       ├── ci.yml
│       ├── gate-scope.yml
│       └── policy-integrity.yml
│
├── core/
│   ├── PRODUCT_VISION.md
│   ├── MVP1_SCOPE_LOCK.md
│   ├── PLAN_MASTER_GATES.md
│   ├── DECISION_LOG.md
│   ├── RISK_REGISTER.md
│   ├── SOURCE_POLICY.md
│   ├── DATA_RETENTION_POLICY.md
│   ├── DEFINITION_OF_DONE.md
│   └── adr/
│       ├── ADR-001-pwa-first.md
│       ├── ADR-002-gmail-telegram-mvp1.md
│       ├── ADR-003-direct-tdlib.md
│       ├── ADR-004-normalized-event.md
│       ├── ADR-005-value-provenance-dag.md
│       ├── ADR-006-durable-ingest-outbox.md
│       ├── ADR-007-cloudflare-tunnel-content-gateway.md
│       ├── ADR-008-opaque-push.md
│       ├── ADR-009-workers-ai-gmail-only.md
│       ├── ADR-010-hard-zero-cost.md
│       └── ADR-011-queue-consumer-runtime.md
│
├── docs/
│   ├── architecture/
│   │   ├── TDD.md
│   │   ├── DATA_MODEL.md
│   │   ├── PROVENANCE_MODEL.md
│   │   ├── THREAT_MODEL.md
│   │   ├── CONNECTOR_ARCHITECTURE.md
│   │   └── OBSERVABILITY.md
│   ├── product/
│   │   ├── USER_FLOWS.md
│   │   ├── MVP1.md
│   │   └── POST_MVP.md
│   └── runbooks/
│       ├── TELEGRAM_CONNECTOR_DOWN.md
│       ├── GMAIL_GAP_RECOVERY.md
│       ├── QUEUE_BUDGET_EXHAUSTED.md
│       ├── QUEUE_EXPIRED.md
│       ├── DLQ.md
│       ├── CONNECTOR_KEY_COMPROMISE.md
│       ├── CONTENT_GATEWAY_KEY_ROTATION.md
│       ├── RESTORE.md
│       └── SECURITY_INCIDENT.md
│
├── apps/
│   └── pwa/
│       ├── src/
│       ├── tests/
│       └── public/
│
├── services/
│   ├── api/
│   ├── ingest/
│   ├── processor/
│   ├── resolver/
│   ├── decision/
│   ├── notification/
│   ├── reporting/
│   └── content-request-broker/
│
├── connectors/
│   ├── common/
│   ├── gmail/
│   └── telegram-tdlib/
│
├── host/
│   ├── content-gateway/
│   ├── backup-agent/
│   └── optional-http-pull-consumer/
│
├── packages/
│   ├── contracts/
│   ├── domain/
│   ├── policy/
│   ├── provenance/
│   ├── telemetry/
│   └── testkit/
│
├── infra/
│   ├── cloudflare/
│   ├── connector-host/
│   └── migrations/
│
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── e2e/
│   ├── policy/
│   ├── security/
│   ├── resilience/
│   ├── quota/
│   └── fixtures/
│
├── governance/
│   ├── plans/
│   ├── reviews/
│   ├── gate-manifests/
│   └── operator-approvals/       # protected/operator-authored only
│
├── reports/
│   └── gate-*/
│
└── scripts/
    ├── verify/
    ├── quota/
    ├── probes/
    │   ├── cloudflare-free-cpu/
    │   └── free-tier-snapshot/
    ├── backup/
    ├── restore/
    └── ops/
```

No Outlook/Slack connector directory belongs to MVP1 implementation scope.

---

# 56. Claude implementation contract

Claude is **IMPLEMENTER**, not final approver.

Claude MAY:

```text
inspect repo
perform recon
prepare a plan
implement operator/GPT-PM approved scope
write/add tests
run local/CI verification
produce evidence
remediate review findings
```

Claude MUST NOT:

```text
self-approve a gate
merge protected main
use production deployment credentials
silently expand MVP1 scope
add Outlook/Slack/etc to MVP1
weaken/delete tests to obtain green
change SourcePolicy/Retention/Security invariants without ADR
introduce paid dependencies/fallbacks
send Telegram-derived data to AI
hide failed tests or quota violations
mark reviewer findings closed without evidence
```

---

# 57. Enforced governance mechanics

Governance is technical, not aspirational.

Required controls:

1. Protected `main` branch; Claude has no direct merge permission.
2. Claude works only on gate/feature branches.
3. Merge and production deployment require operator-controlled identity/token.
4. Production secrets/deploy credentials are not available to Claude implementation context.
5. Each gate has a binding `gate-manifest.yaml` containing:

```text
plan_id
plan_hash
approved_scope
allowed_paths
forbidden_paths
required_tests
required_reviewers
policy_sensitive_files
```

6. **Gate manifest ownership:** the binding manifest is created/committed by the operator or governance authority, not by the implementer.
7. `governance/gate-manifests/**` and `governance/operator-approvals/**` are policy-sensitive protected paths.
8. CI validates the manifest content hash against an operator-controlled approved hash stored outside the implementer's writable branch state (protected environment variable / protected branch approval record).
9. A manifest modified only in Claude's branch has no authority and causes gate-scope CI failure.
10. CI computes changed paths and fails when outside the approved manifest scope.
11. Changes deleting/disabling/skipping tests require an explicit approved finding/remediation reference.
12. CI reports test count and coverage/diff changes.
13. Policy-sensitive files require explicit operator/GPT-PM approval, including:

```text
SOURCE_POLICY
RETENTION_POLICY
SECURITY invariants
cost mode
AI provider config
gate manifests/operator approvals
```

14. At least one substantive gate review occurs in a fresh context independent of the implementer context.
15. Claude may prepare a proposed next-gate manifest as an artifact, but it is non-binding until adopted by operator/governance authority.

Governance invariant:

```text
The actor being constrained cannot modify the authoritative object that defines the constraint.
```

---

# 58. Gate workflow

```text
1. Recon
2. Plan
3. Plan review
4. GO
5. Implementation
6. Test/verification
7. Implementer self-check
8. Independent review(s)
9. Remediation
10. Re-verification
11. Final verdict
12. Closure report
13. Operator merge/push
```

No GO at step 4 => no implementation.

No final approval => no gate closure.

---

# 59. Review agents

The agents are roles with explicit separation of responsibilities. A role may be fulfilled by a fresh Claude session, GPT-PM, another model, or a human, but the final gate must not rely only on multiple personas sharing the implementer's same context.

## ARCH-01 - Principal Architecture Reviewer

Checks boundaries, coupling, unnecessary infrastructure, failure modes, data ownership, scope creep.

## SEC-01 - Security Reviewer

Checks authentication, OAuth/session storage, content gateway, tunnel, replay, web security, supply chain, backups.

## PRIV-01 - Privacy/Platform Compliance Reviewer

Checks Telegram terms, source provenance, AI policy, data minimization, retention/deletion and policy bypass.

## DATA-01 - Data/State Reviewer

Checks schema, migrations, idempotency, provenance DAG, state transitions, reversibility, D1 indexes and quota efficiency.

## REL-01 - Reliability/SRE Reviewer

Checks spool, Gmail gap recovery, queue expiry, reconciler, DLQ, restart/recovery and backup/restore.

## AI-01 - AI/Decision Reviewer

Checks AIContextBuilder, taint policy, schema validation, hallucination boundaries, evidence and AI-off fallback.

## QA-01 - Adversarial QA Reviewer

Breaks duplicates, ordering, source deletion, stale OAuth, reconnect, bad dates, malformed payloads and topic false merges.

## UX-01 - PWA/Mobile Reviewer

Verifies Android, iPhone Home Screen PWA, drill-down, opaque push, sync-on-open and degraded UX.

## GOV-01 - Governance Reviewer

Checks plan hash/scope, path controls, test changes, evidence completeness and DoD.

## RED-01 - Final Adversarial Reviewer

Attempts to reject the completed gate by finding hidden assumptions, false PASS, policy bypasses and untested failure modes.

---

# 60. Review severity

```text
BLOCKER
MAJOR
MINOR
INFO
```

Rules:

```text
>=1 unresolved BLOCKER => REJECT
>=1 unresolved MAJOR   => REJECT
MINOR may close only as explicit accepted debt
INFO non-blocking
```

Implementer cannot unilaterally downgrade reviewer severity.

---

# 61. CI requirements

Every commit/gate as applicable:

```text
format
lint
typecheck
unit tests
contract tests
policy tests
secret scan
dependency scan
migration validation
scope/path enforcement
test-deletion guard
```

Gate-level:

```text
integration tests
resilience tests
quota-budget tests
security tests
PWA build
fresh-context review evidence
```

No ignored failing tests.

---

# 62. Mandatory resilience tests

At minimum:

```text
same event submitted 10 times
out-of-order updates
Telegram connector offline 6h then reconnect
Telegram connector restart with pending spool
TDLib first-login cache contains older messages -> none emitted centrally before connected_at
Gmail watch renewal
Gmail history cursor 404 -> bounded gap recovery
queue unavailable
queue event expiry -> reconciler recovery
queue soft budget reached -> durable accept continues, dispatch pauses, next-window recovery works
poison event -> <=MAX_PROCESSING_ATTEMPTS -> terminal DLQ -> no reconciler loop
D1 transient error
AI quota exhausted
AI disabled
Telegram-tainted value/assignment attempted in AI context -> blocked
Topic/Stream/Person object attempted in MVP1 AI context -> type/runtime blocked
Gmail AI executes before cross-channel merge only
source message deleted before drill-down
Cloudflare Tunnel unavailable
Telegram content replay/expired nonce -> rejected
PWA offline
push lost/delayed -> open-sync correct
iOS standalone Home Screen Access login and re-login
```

CPU/quota resilience:

```text
consumer max_batch_size=1 under conservative mode
empirical Free-plan CPU probe
p95 active CPU <=8ms target under representative event workload
MAX_TOPIC_CANDIDATES bound enforced
no unindexed scan under 200/day and 1000/day simulations
```

---

# 63. Time/date handling

Canonical storage uses UTC instants where possible.

User timezone is explicit application configuration.

MVP1 must test:

```text
Europe/Chisinau
DST transitions
"today"
"tomorrow"
"by Friday"
messages crossing midnight
provider timestamps
```

A parsed relative date is provenance-bearing.

---

# 64. Hard-zero cost mode

Configuration:

```text
COST_MODE=HARD_ZERO
```

Startup/deployment checks reject:

```text
paid AI fallback
paid queue fallback
auto-upgrade billing path
unapproved paid SaaS dependency
```

OPS displays current quota use and the declared mandatory recurring cost.

MVP1 cost statement is:

```text
$0/month is realistic IF:
- free tiers stay within published limits, and
- an already-owned or truly free always-on Telegram host is available.
```

This is not a promise that third-party free tiers will remain unchanged forever.

---

# 65. Current external platform facts used by v0.3

Verified 2026-09-10. These are external assumptions and MUST be re-fetched at the gate that depends on them.

Cloudflare Workers Free:

```text
100,000 requests/day
10 ms active CPU per invocation in the Workers Free limits/pricing table
```

Cloudflare Queues Free:

```text
10,000 operations/day
24h non-configurable message retention
HTTP pull consumers are supported on Free
```

Queue CPU documentation caveat:

```text
Workers Free docs: 10 ms CPU/invocation.
Queues limits docs: describe consumer default 30s / configurable 5m and state most Queue limits apply to Free and Paid,
while also saying consumer Workers share Workers per-invocation CPU limits.
```

Therefore MVP1 **assumes only 10 ms active CPU** for a Worker consumer until an empirical test on the actual account proves a larger supported budget. The design remains valid under the 10 ms interpretation.

Cloudflare D1 Free:

```text
5M rows read/day
100K rows written/day
500MB per database
5GB total account storage
7-day Time Travel on Free
hard daily query enforcement
```

Workers Analytics Engine Free published allowance:

```text
100K data points/day
10K read queries/day
```

Cloudflare Tunnel:

```text
outbound-only origin connection
no public IP/open inbound ports required
available on all plans
```

Workers AI:

```text
available through REST API from outside Workers
Customer Content documented as not used to train Workers AI models / improve services without explicit consent
selected model/license/source policy still requires gate verification
```

Apple:

```text
Home Screen web apps support Web Push on iOS 16.4+
```

Gmail:

```text
users.watch must be renewed; daily renewal recommended
historyId may expire and return 404
post-connection gap recovery is mandatory
```

D1 long-term export:

```text
D1 can be exported via official API / wrangler d1 export
export may temporarily make the database unavailable while an export is in progress
```

Reference URLs are maintained in `docs/architecture/EXTERNAL_ASSUMPTIONS.md` and snapshotted by `scripts/probes/free-tier-snapshot/` during G0/G2.

---

# 66. Retention/backup/observability reporting cadence

Daily automated:

```text
connector health
accepted-unprocessed reconciliation
retention job as scheduled
quota snapshot
gap/watch health
backup status
```

Weekly user/product:

```text
stream progress
open decisions
commitments
milestones
stale work
```

Weekly engineering:

```text
loss indicators
duplicates
queue/reconciler
latency
quota trend
policy blocks
```

Quarterly or before source-policy change:

```text
Telegram ToS re-review
AI provider terms review
retention review
```

---

# 67. Universal Definition of Done

A gate is DONE only if all applicable items are true:

1. Approved plan ID/hash exists.
2. Binding gate-manifest hash is operator-authorized and CI-verified.
3. Implementation scope exactly matches approved scope.
4. Changed paths comply with gate manifest.
5. No unrelated source or feature entered the gate.
6. Code is committed on the approved branch.
7. Build passes.
8. Format/lint/typecheck pass.
9. Unit tests pass.
10. Contract/integration tests pass where applicable.
11. New behavior has tests.
12. Failure/recovery paths have tests.
13. Security implications reviewed.
14. Source policy implications reviewed.
15. Provenance/taint implications reviewed.
16. No source-derived content leaks to logs/metrics/push/fixtures.
17. Observability exists for new runtime behavior.
18. Documentation updated.
19. ADR updated/added when architecture or policy changed.
20. Required review agents completed evidence-backed review.
21. At least one substantive review is fresh-context independent from implementer context.
22. Zero unresolved BLOCKER.
23. Zero unresolved MAJOR.
24. Accepted MINOR debt is explicit.
25. Exact verification commands/results recorded.
26. Rollback/recovery documented where applicable.
27. Applicable quota/CPU budget remains within HARD_ZERO constraints.
28. Policy-sensitive file integrity checks pass.
29. Gate-specific DoD is complete.
30. Closure report produced.
31. Final gate authority returns APPROVE.

A green test suite alone never closes a gate.

---

# 68. Telegram Connector DoD

Telegram connector is DONE only if:

```text
personal account login works
session persistence works
new message event works
no pre-connection bulk backfill occurs
reconnect after 6h outage works
source recovery behavior documented
local spool survives process restart
central dedupe works
health/last-event metrics exposed
TDLib version/checksum pinned
session secrets protected
raw content absent from central event contract
raw content absent from logs/metrics/queue/push
all deterministic derived values carry Telegram provenance
AI policy test proves Telegram ancestry blocked
full-message drill-down works on Android PWA
ditto on iPhone PWA when source available
deep-link capability is tested separately where supported
disconnect/session revoke runbook exists
```

---

# 69. Gmail Connector DoD

Gmail connector is DONE only if:

```text
OAuth works with least privilege
watch/push or explicitly selected poll mode works
Pub/Sub OIDC/JWT verification works when push mode used
watch renewal works
incremental history works
expired history cursor triggers bounded gap recovery
no message older than connected_at is silently backfilled
duplicate recovery events dedupe correctly
full original message/thread drill-down works
tokens encrypted and never logged
source health visible
failure/recovery runbook exists
```

---

# 70. Provenance/AI Policy DoD

DONE only if automated policy/type-boundary tests prove:

```text
raw Telegram -> AI BLOCKED
Telegram-derived string -> AI BLOCKED
Telegram-derived number -> AI BLOCKED
Telegram-derived datetime -> AI BLOCKED
Telegram-derived boolean -> AI BLOCKED
Telegram-derived display name -> AI BLOCKED
Telegram-derived enum assignment -> AI BLOCKED
Telegram-derived count/aggregate -> AI BLOCKED
Telegram-derived routing hint -> AI BLOCKED
nested/mixed ancestry -> AI BLOCKED
unknown ancestry -> AI BLOCKED
Topic object -> MVP1 AI API TYPE/SCHEMA BLOCKED
Stream object -> MVP1 AI API TYPE/SCHEMA BLOCKED
Person/shared identity object -> MVP1 AI API TYPE/SCHEMA BLOCKED
GmailEvidenceBundle with Gmail-only eligible ancestry -> ALLOWED
Gmail AI enrichment occurs before cross-channel resolution
combined Gmail+Telegram Topic is never serialized into AI request
AI serializer cannot bypass provenance gate
```

No eyes-only review substitutes for these tests.

---

# 71. Queue/Reliability DoD

DONE only if:

```text
accepted event persists before ACK
outbox dispatch works
consumer is idempotent
queue outage recovery works
simulated 24h queue expiry is recovered by reconciler
reconciliation creates no logical duplicates
FAILED/DLQ terminal states are excluded from reconciler
poison event reaches DLQ in <=MAX_PROCESSING_ATTEMPTS and never loops
queue soft-budget degradation preserves accepted events
next-quota-window recovery works
DLQ visible and actionable
oldest accepted-unprocessed metric exists
MAX_TOPIC_CANDIDATES is bounded and tested
consumer active-CPU quota harness passes conservative target (p95 <=8ms) OR ADR-011 selects HTTP pull host consumer after empirical evidence
200-event/day and 1000-event/day D1/Queue/request budget tests pass
```

No implementation may rely on undocumented/ambiguous Queue CPU headroom.

---

# 72. Topic Resolver DoD

DONE only if:

```text
project-scoped identifier namespace enforced
confirmed cross-project auto-merge impossible
auto-merge threshold tested
candidate merge tested
manual merge tested
manual split tested
merge reason/score/version audited
Telegram+Gmail deterministic-link scenario passes
UNKNOWN/separate behavior tested
false-merge metric exposed
```

---

# 73. Decision/State DoD

DONE only if:

```text
decision schema validated
every decision has evidence
priority explainable
unsupported recommendation rejected
AI-off mode works
Telegram contribution never leaks into AI context
commitment state transitions tested
basic milestone state transitions tested
resolution audited
```

---

# 74. Security DoD

DONE only if:

```text
threat model current
auth enforced
secret scan clean
OAuth/session storage reviewed
Pub/Sub authentication tested
connector replay protection tested
connector key rotation tested or exercised in staging
Cloudflare Tunnel ContentRequest full auth chain tested
Telegram ECDH/HKDF/AES-GCM content envelope test passes
expired/replayed content nonce rejected
CSP/security headers verified
raw-content logging test clean
opaque push payload test clean
AI human-facing fields rendered plain text with length cap
prompt injection tests pass
TDLib dependency/checksum verified
backup encryption/recovery key procedure tested
gate-manifest/operator-approval integrity CI passes
```

Push timing visibility to FCM/APNs is documented as an accepted residual metadata risk.

---

# 75. PWA/Push DoD

DONE only if:

```text
Android PWA installs and opens
Android Web Push functional on target device
iPhone Home Screen PWA installs and opens
iPhone Web Push functional on target iOS 16.4+ device
Cloudflare Access/application login works in iOS standalone Home Screen mode
re-login after session expiry works in iOS standalone mode
push payload inspected and proven opaque
lost/delayed push does not lose state
resume/open sync repairs notification gap
full Gmail drill-down works
full Telegram drill-down works when source available
Telegram raw response is application-layer encrypted through Cloudflare intermediary path
PWA decrypts Telegram content locally
service worker does not cache message bodies
AI/source-derived fields render as inert plain text, not markdown/HTML
```

No percentage delivery SLA is invented for best-effort push.

---

# 76. Observability DoD

DONE only if operator can answer from OPS/trace data:

```text
Is Telegram listener alive?
Is Gmail collection alive?
Did event X get accepted?
Why is event X unprocessed?
Why were events merged?
Why was a decision created?
Why did push fail/not appear?
Did reconciler recover anything?
Did restricted provenance touch AI?
What are current free-tier budgets?
When was last good backup/restore test?
```

---

# 77. Backup/DR DoD

DONE only if:

```text
backup-agent runs on connector host, not Worker CPU path
official D1 export API / pinned Wrangler export succeeds
backup compressed locally
backup encrypted locally before R2 upload
backup manifest/checksum produced
least-privilege backup API token documented and stored outside repo
Telegram raw history excluded
operator recovery key procedure documented
isolated restore succeeds
schema/constraints validated after restore
representative project/topic/decision works after restore
first restore test completed before MVP1 closure
backup and restore ages shown in OPS
```

A backup that has not been restored is not considered valid.

---

# 78. MVP1 functional deliverables

MVP1 MUST deliver:

## Sources

```text
Gmail
Personal Telegram
```

## Core

```text
automatic new-event collection
normalized event contract
durable ingest + idempotency
queue + reconciler
direct TDLib Telegram path
Gmail push/history or explicit poll mode
value-level provenance/taint
identity/project/stream/topic association
cross-channel Telegram+Gmail topic merge
decision detection
commitments
minimal milestones/ETA state
priority engine
knowledge/deliverable references
full source drill-down
```

## Client

```text
PWA
Android
Home Screen iPhone
Web browser
```

## Operations

```text
opaque Web Push
OPS dashboard
structured logs/traces
retention
backup
restore test
HARD_ZERO quota dashboard
```

---

# 79. MVP1 critical proof scenario

The mandatory demonstration is exactly two sources.

Telegram:

```text
"Need GO on Gate 4.2"
```

Gmail:

```text
Subject: Gate 4.2 regression complete
Body: regression passed; approval requested before rollout
```

Precondition:

```text
project/stream mapping establishes ERP namespace
business identifier resolves as ERP::Gate-4.2
```

Expected:

```text
ONE PROJECT
ERP

ONE STREAM
Gate 4.2 / release

ONE TOPIC
cross-source topic

ONE DECISION
approval required

EVIDENCE
Telegram source ref
Gmail source ref

DRILL-DOWN
full Telegram original on demand
full Gmail original on demand
```

AI may analyze Gmail evidence only. Telegram and Telegram-derived values remain blocked from AI.

---

# 80. MVP1 quantitative evaluation

Minimum shadow evaluation set before closure:

```text
>=200 labeled total events
>=30 Telegram+Gmail cross-source topic cases
>=30 decision/action cases
>=20 deliberately ambiguous/no-merge cases
>=10 cross-project identifier collision cases
```

Label rubric must be written before the final quality run.

Exit quality targets:

```text
accepted-event loss under tested transient failures     0
logical duplicate rate                                  <0.5%
auto-merge precision                                    >=95%
linkable-case merge recall                              >=85%
confirmed cross-project false auto-merge                 0
Gmail decision precision                                >=90%
Gmail decision recall                                   >=85%
Telegram deterministic decision-pattern precision        >=95%
Telegram semantic recall                                 informational/non-blocking
all decisions without evidence                           0
Telegram/mixed AI policy violations                      0
source-derived push payload violations                   0
unresolved DLQ at closure                                0
```

If precision fails, lower automation/raise candidate-review threshold rather than forcing recall.

---

# 81. MVP1 performance/reliability targets

```text
source accepted -> visible state p95   <60s in healthy push mode
Gmail poll fallback freshness          configured/documented; target <=5m
accepted event eventually processed    100% in tested recoverable scenarios
connector outage recovery              tested at 6h
queue expiry recovery                  100% tested events
```

Push delivery itself is best-effort and is not used as correctness state.

---

# 82. MVP1 Exit Definition of Done

MVP1 is CLOSED only when every applicable universal/component DoD is closed AND:

```text
MVP1 source scope contains exactly Gmail + Telegram
Android PWA works
Home Screen iPhone PWA works
Web works
no normal-use desktop dependency

Telegram personal-account collection works
Gmail collection works
pre-connection history backfill remains OFF
TDLib initial local cache does not emit pre-connected_at central events
Gmail gap recovery works
Telegram reconnect recovery works

accepted event durability/idempotency proven
queue expiry reconciliation proven
poison-event termination proven
HARD_ZERO queue-budget degradation/recovery proven
Free-plan CPU empirical probe recorded
consumer path satisfies conservative CPU budget or ADR-011 selects tested HTTP pull fallback

at least one real/safely-labeled topic combines BOTH source types
one combined topic produces one decision with evidence from both
no cross-channel Topic/Decision state is sent to AI

user can navigate:
Project -> Stream -> Topic -> Decision -> Evidence

user can view full original Gmail message in app
user can view full original Telegram message in app when source remains available
Telegram drill-down ciphertext traverses Cloudflare; plaintext decrypts only in PWA/connector gateway endpoints

Today screen shows prioritized actions/decisions
commitments work
minimal milestones work
knowledge/deliverable refs work

opaque Web Push works functionally on Android
opaque Web Push works functionally on target iPhone Home Screen PWA
iOS standalone authentication/re-authentication works
sync-on-open repairs missed push

value/assignment-level provenance DAG enforced
AI input type limited to GmailEvidenceBundle
Gmail AI runs before cross-channel merge
0 Telegram-derived values/assignments in AI requests
0 shared Topic/Stream/Person state in MVP1 AI requests
0 source-derived values in push transport

AI disabled mode works
AI free quota exhaustion degrades safely

OPS dashboard complete
quota budget test complete
retention run complete
host-side backup complete
first isolated restore test complete
binding gate-manifest integrity mechanism demonstrated

all required independent reviews complete
0 BLOCKER
0 unresolved MAJOR
quality thresholds satisfied
operator acceptance complete
```

No partial closure.

---

# 83. Binding MVP1 gate plan

```text
G0  Implementation-readiness verification + ADR freeze
    - adopt TDD v0.3 FINAL into repo
    - live Telegram terms re-check
    - live Cloudflare/Gmail/free-tier assumption snapshot
    - empirical Cloudflare Free CPU smoke harness
    - decide/record ADR-011 push Worker consumer vs HTTP pull fallback (default: Worker <=10ms budget)
    - threat model
    - ADR-002 scope lock
    - ADR-003 direct TDLib
    - ADR-005 provenance/assignment DAG + Gmail-only pre-aggregation AI boundary
    - ADR-007 Cloudflare Tunnel + full ContentRequest auth chain + mandatory Telegram E2E envelope
    - ADR-008 opaque push
    - ADR-009 Gmail-only AI provider/data terms
    - ADR-010 HARD_ZERO
    - establish operator-owned gate-manifest integrity mechanism

G1  Repository + governance enforcement + CI + contracts

G2  D1 schema + provenance primitives + durable ingest/outbox
    + Queue/reconciler/DLQ + soft-budget guard
    + CPU/quota harness + live Analytics Engine limits snapshot

G3  Gmail connector
    - OAuth
    - push/watch authentication
    - renewal
    - bounded post-connection gap recovery
    - billing-account check + explicit poll fallback
    - GmailEvidenceBundle + source-local AI extraction before merge

G4  Telegram direct TDLib connector
    - session
    - connected_at initial-cache emission boundary
    - local spool
    - deterministic rules/provenance
    - offline/reconnect
    - Tunnel Content Gateway
    - ECDH/HKDF/AES-GCM source drill-down

G5  Identity + Project + Stream + Topic resolver
    - namespaced identifiers
    - candidate/merge/split
    - cross-project hard barrier
    - no AI feedback from combined topic

G6  Intent + Decisions + Commitments + Minimal Milestones + Priority

G7  PWA + Today + evidence drill-down + opaque Web Push
    - Android real-device
    - iPhone Home Screen real-device
    - standalone Access login/re-login

G8  Observability + reporting + retention + host-side backup + first restore

G9  Shadow evaluation + calibration + adversarial end-to-end review

G10 MVP1 closure
```

Each gate requires its own binding operator-approved manifest and plan-level GO. Completion of one gate does not authorize the next.

---

# 84. Post-MVP connector strategy

After MVP1 proves the core hypothesis, extend sources without changing the domain model.

Potential order:

```text
Outlook
Slack
WhatsApp
Signal
LinkedIn
Instagram/Facebook Messenger
Discord
X
Google Messages
Google Chat
```

For multi-network expansion, re-evaluate Beeper/mautrix bridges as reusable protocol adapters.

MVP1's decision to use direct TDLib does not reject mautrix generally; it rejects Matrix overhead for a two-source MVP.

---

# 85. Accepted residual risks / implementation watchlist

## R1 Telegram deterministic aggregation remains YELLOW/UNCLEAR

The design excludes Telegram from AI but cross-channel operational use of Telegram-derived state remains a contractual area that must be periodically re-reviewed. MVP1 minimizes content replication and keeps raw Telegram content source-local.

## R2 Free always-on host

$0/month requires an already-owned or genuinely free always-on host for TDLib. Host downtime degrades Telegram ingestion and Telegram drill-down until recovery.

## R3 Gmail Pub/Sub billing-account requirement

Google Cloud setup may require a billing-account attachment despite expected $0 consumption. Explicit polling fallback exists if the operator refuses this prerequisite.

## R4 Telegram semantic recall ceiling

Without ML over Telegram, some semantically related Gmail/Telegram events will remain separate unless deterministic identifiers, mappings, participants and timing are sufficient. Precision is intentionally preferred over recall.

## R5 Free-tier platform drift

Cloudflare/GCP quotas and semantics may change. Live gate snapshots, HARD_ZERO controls and quota telemetry reduce but cannot eliminate this dependency.

## R6 Source deletion

If an original source message is deleted and raw content was not centrally retained, historical drill-down may become unavailable. This is an intentional data-minimization trade-off.

## R7 Push timing metadata

FCM/APNs/transport infrastructure can observe that a push occurred and its time even though payload content is opaque. This is accepted residual metadata leakage.

## R8 Cloudflare Queue CPU documentation ambiguity

Official Cloudflare pages currently describe Queue CPU inconsistently relative to the Workers Free 10 ms table. Architecture assumes the stricter 10 ms limit and therefore remains valid under either interpretation; G0/G2 empirical probes record actual account behavior.

---

# 86. Implementation readiness decision

The second adversarial review's actionable findings are incorporated into v0.3:

```text
B1 scope                           CLOSED
B2 value/assignment provenance     CLOSED
B3 opaque push                     CLOSED
B4 Tunnel/content path             CLOSED
M1 direct TDLib                    CLOSED
M2 Gmail gap recovery              CLOSED
M3 quota-aware telemetry           CLOSED
M4/NB1 CPU assumption              CLOSED conservatively
M5 queue expiry                    CLOSED
M6 iOS push correctness            CLOSED
M7/NM3 governance enforcement      CLOSED
M8 AI provider terms               CLOSED conditionally at live gate verification
M9 namespaced merge barrier        CLOSED
M10 two-source metrics             CLOSED
NM2 AI leakage seam                CLOSED by Gmail-only pre-aggregation AI
NM4 poison reconciler              CLOSED
```

Implementation readiness does **not** mean all external assumptions are permanent facts. G0 intentionally re-verifies terms/quotas and runs the empirical CPU probe before runtime configuration is frozen.

No third design review is required merely to begin G0. Any new BLOCKER/MAJOR discovered during implementation still blocks the affected gate under normal governance.

---

# 87. Final architecture verdict

```text
TDD VERSION: v0.3 FINAL
PLAN STATUS: IMPLEMENTATION BASELINE APPROVED FOR GATE-BY-GATE EXECUTION
MVP1: Gmail + personal Telegram ONLY
FIRST AUTHORIZED ACTIVITY: G0 after operator GO
BLANKET IMPLEMENTATION AUTHORIZATION: NO
```

The core MVP1 hypothesis is:

```text
Can a personal system automatically collect new Gmail + personal Telegram events,
perform AI enrichment only on Gmail before cross-channel aggregation,
combine deterministically linkable evidence into one work topic/decision,
show the user what needs attention,
preserve trustworthy encrypted drill-down to original evidence,
and remain reliable/privacy-controlled without mandatory recurring cost?
```

MVP1 is successful only when the user experiences **one operational state and one decision surface rather than two inboxes**, while every conclusion remains evidence-backed and the Telegram/AI boundary is mechanically enforced.

Everything outside that proof belongs after MVP1.
