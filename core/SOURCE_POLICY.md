# Source Policy

Source: `docs/architecture/TDD.md` §6, §24-25, §3-4. Policy-sensitive file — changes require ADR +
independent review + operator approval (project `CLAUDE.md` §2, §6).

## Telegram

Current Telegram API Terms state that data obtained from Telegram may not be used/accessed/
aggregated to train, fine-tune, or otherwise develop/enhance/deploy AI/ML systems. Telegram
Content Licensing terms separately limit access to ordinary legitimate use with a limited
exception for legitimate Telegram clients. This must be re-fetched and re-reviewed at G0 (item B)
before implementation GO, and periodically thereafter (quarterly, or on any terms change).

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
