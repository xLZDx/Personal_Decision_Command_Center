# MVP1 Scope Lock

Source scope is binding — changing the implemented source list requires an operator-approved scope
revision, not an implementer decision.

Architecture/policy for those sources is read using the current amended architecture order in
`../CLAUDE.md`; this scope file must not resurrect a superseded source-policy invariant.

## In scope (exactly)

```text
Gmail
Personal Telegram account
```

## Explicitly POST-MVP (not to be pulled in by any gate)

```text
Outlook / Microsoft 365, Slack, WhatsApp, Signal, LinkedIn, Instagram / Facebook Messenger, X,
Discord, Google Messages / SMS, Google Chat, Notion, Jira, GitHub, calendar write actions,
native iOS / Android applications
```

A later source may get design placeholders/interfaces, but no implementation gate may pull it into
MVP1 without an operator-approved scope revision.

## MVP1 non-goals

MVP1 does NOT:

- replace Telegram/Gmail as full clients;
- import the whole historical Telegram account;
- train or fine-tune a model on communication content;
- use Telegram content as a broad model validation/benchmark dataset;
- build a broad historical Telegram embedding/vector index or scraping/harvesting pipeline;
- treat Telegram, Gmail or any future source as blanket AI_ALLOW based only on source name;
- bypass the context/purpose/consent/provenance rules in `adr/ADR-012-telegram-ai-context-policy.md`;
- make autonomous external business decisions or send external replies autonomously;
- become a commercial multi-tenant SaaS;
- build a full PM suite;
- promise perfect semantic Telegram understanding;
- build Matrix/mautrix infrastructure or require Beeper;
- depend on desktop availability for normal operation.

### Telegram AI clarification

Scoped AI inference over Telegram-derived evidence is **not categorically a non-goal** anymore.

It is eligible only where the current SourcePolicy proves the exact ingress mode, purpose,
content/chat/context scope, required consent/authorization, current terms snapshot and provenance
ancestry. Unknown/expired/revoked/incompatible/unprovable authorization fails closed.

For personal TDLib/private chats this means AI remains DENY by default unless the required
relevant-user, context-bounded consent can be demonstrated. Bot/Mini-App/Business-chatbot policy
rules do not create blanket permission for personal-account history.

This policy clarification does not add a third source and therefore does not widen the source-list
scope above.

## Primary client

Mobile-first PWA: Android + iPhone (Home Screen) + Web. Desktop not required for normal use.

## Cost constraint

Mandatory recurring infrastructure cost target = **$0/month** (`HARD_ZERO`, see
`adr/ADR-010-hard-zero-cost.md`), conditional on an already-owned or genuinely free always-on
Telegram connector host and free tiers staying within published limits.
