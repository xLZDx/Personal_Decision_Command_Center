# Source Policy

Source: `docs/architecture/TDD.md` §6, §24-25, §3-4. Policy-sensitive file — changes require ADR +
independent review + operator approval (project `CLAUDE.md` §2, §6).

## Telegram

**Verified live 2026-09-10** (G0 item B — see `docs/architecture/EXTERNAL_ASSUMPTIONS.md` for
URLs, content hashes and full quotes). The prohibition is **broader** than this file originally
summarized. Content Licensing and AI Scraping Terms, verbatim:

> "For clarity, Telegram firmly prohibits the scraping, indexing, harvesting, aggregation or use
> of data obtained from its platform to train, fine-tune, validate or otherwise engage in the
> development, enhancement, benchmarking or deployment of artificial intelligence, machine
> learning models and similar technologies."

Note the verbs beyond "train/fine-tune": **scraping, indexing, harvesting, validate,
benchmarking**. Consequences the narrower reading would have missed — a vector/embedding **index**
over Telegram content is prohibited even with no model training; using Telegram content as an
**evaluation/benchmark set** is prohibited; **aggregation** for these purposes is prohibited
independently of any model.

API Terms §1.5 carries the same prohibition and additionally binds API use to the Content
Licensing terms. API Terms §1.3/§1.4 require a client not to break expected Telegram behavior —
relevant to G4: do not implement a "ghost mode"/don't-mark-as-read feature, which §1.4 names
explicitly as forbidden tampering.

A consent exception exists in the Content Licensing terms but requires explicit, informed,
continued consent from **all relevant users** (i.e. counterparties, not just the operator) per
chat/context. MVP1 deliberately does not rely on it — recorded so the exception is visibly
considered and declined rather than unmentioned.

Neither document carries a version number or `Last-Modified` header, so "current text" is pinned
by fetch date plus SHA-256 of extracted text (recorded in `EXTERNAL_ASSUMPTIONS.md`). Re-fetch
quarterly and before any change to AI scope.

```
Telegram realtime client receive         ALLOWED DESIGN PATH
Telegram normal display                  ALLOWED DESIGN PATH
Telegram on-demand original drill-down    ALLOWED DESIGN PATH
Telegram deterministic routing            PERMITTED ASSUMPTION; revalidate at G0 and periodically
Telegram raw -> LLM                       FORBIDDEN
Telegram raw -> embeddings                FORBIDDEN
Telegram-derived values -> LLM            FORBIDDEN
Telegram-derived values in AI prompts     FORBIDDEN
Telegram historical AI index              FORBIDDEN
```

Per global CLAUDE.md §23: this policy is enforced because the operator has read and adopted these
terms as part of the TDD's own governance baseline (not because a reviewer asserted it unread) —
if any future reviewer finding claims a NEW prohibition not already in this file, verify the
primary source before treating it as binding; do not invent additional restrictions.

## Gmail

Gmail source policy may allow AI (Workers AI, Gmail-source-local only). Cloudflare Workers AI
Customer Content is documented as not used to train models or improve services without explicit
consent (as of the TDD's verification date) — this must be re-verified at G0/ADR-009 before
production Gmail content is sent to AI, along with the selected model's own license/provider terms.

## MVP1 AI boundary (binding — see INV-03/04/05/26)

The only AI input type in MVP1 is `GmailEvidenceBundle`, built from Gmail source evidence **before**
cross-channel topic resolution. It must not contain Topic/Stream/Person shared-state,
cross-channel participants/counts/aggregates, or any Telegram-derived value or assignment. After
the deterministic cross-channel resolver combines Gmail and Telegram into a Topic/Decision, that
combined state is never sent back to AI in MVP1. A combined-topic AI summary/recommendation is
explicitly POST-MVP and requires its own source-policy/compliance review.

## Composition rule

`ai_safe(value) = all provenance ancestors are AI_ALLOW`. Unknown/mixed ancestry = `AI_DENY`. See
`docs/architecture/TDD.md` §7.2 for the mandatory automated test this rule implies.
