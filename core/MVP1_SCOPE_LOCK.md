# MVP1 Scope Lock

Source: `docs/architecture/TDD.md` §3-4, §55. Binding — changing this file's scope requires an
operator-approved scope revision, not an implementer decision.

## In scope (exactly)

```
Gmail
Personal Telegram account
```

## Explicitly POST-MVP (not to be pulled in by any gate)

```
Outlook / Microsoft 365, Slack, WhatsApp, Signal, LinkedIn, Instagram / Facebook Messenger, X,
Discord, Google Messages / SMS, Google Chat, Notion, Jira, GitHub, calendar write actions,
native iOS / Android applications
```

A later source may get design placeholders/interfaces, but no implementation gate may pull it into
MVP1 without an operator-approved scope revision.

## MVP1 non-goals

MVP1 does NOT: replace Telegram/Gmail as full clients; import the whole historical Telegram
account; train/fine-tune/benchmark a model on communication content; run LLMs/embeddings over raw
or derived Telegram content; make autonomous external decisions; send external replies
autonomously; become a commercial multi-tenant SaaS; build a full PM suite; promise perfect
semantic Telegram understanding; build Matrix/mautrix infrastructure; require Beeper; depend on
desktop availability for normal operation.

## Primary client

Mobile-first PWA: Android + iPhone (Home Screen) + Web. Desktop not required for normal use.

## Cost constraint

Mandatory recurring infrastructure cost target = **$0/month** (`HARD_ZERO`, see
`adr/ADR-010-hard-zero-cost.md`), conditional on an already-owned or genuinely free always-on
Telegram connector host and free tiers staying within published limits.
