# Workers AI model and terms snapshot

Snapshot date: 2026-09-14 (Europe/Chisinau)

Gate: G3 Gmail connector

Decision status: approved for MVP1 development and later owner-enabled Gmail-only use; production
content remains disabled until deployment configuration satisfies the controls below.

## Selected model

- Callable and priced model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Cloudflare describes it as Cloudflare-hosted, with a 24,000-token context window, and lists the
  exact same id among JSON Mode models and in the pricing table.
- MVP1 caps the complete serialized request at 16,000 UTF-8 bytes and output at 256 tokens. The
  context-window maximum is therefore not treated as an application allowance.
- JSON Mode is only an output request mechanism. Cloudflare explicitly documents that conformance
  can fail, so the application validates output locally and fails closed.

## Customer Content position

Cloudflare's data-usage page says inputs and outputs are Customer Content. It states that Customer
Content is not shared with other Cloudflare customers and is not used to train Workers AI models or
improve Cloudflare/third-party services without explicit consent. It also says content may be stored
when a separate storage service is deliberately used with Workers AI.

MVP1 implications:

- only owner-authorized, Gmail-origin `GmailEvidenceBundle` content may enter the provider;
- the Gmail content loader must attach an HMAC over event/account/message identity and the exact
  fetched bytes; the engine verifies this Worker Secret before constructing the evidence bundle;
- no Telegram or cross-channel derived content may enter the provider;
- no AI Gateway logging, R2, KV, Durable Object, Vectorize, or other provider-side storage is
  enabled for AI requests;
- raw request/response bodies are never written to application logs;
- application persistence is limited to schema-validated `GmailSourceEnrichment`, model id, and run
  metadata required by the TDD.

## Model license and use policy

Cloudflare links this model to Meta's Llama 3.3 terms. Meta publishes the Llama 3.3 Community License
and a separate Acceptable Use Policy. The license grants a limited royalty-free right to use the
materials subject to its conditions, requires compliance with applicable law and the use policy,
and contains redistribution/attribution and large-platform conditions. MVP1 uses Cloudflare-hosted
inference and does not redistribute model weights or create/train another model.

The repository does not treat this engineering snapshot as legal advice. Any future redistribution,
fine-tuning, public multi-user product, or materially changed purpose requires a fresh license review.

## HARD_ZERO accounting decision

Cloudflare documents a free allocation of 10,000 Neurons/day, reset at 00:00 UTC. The exact callable
model id also appears verbatim in Cloudflare's pricing table. Reservation and reconciliation use
that exact model's published rates:

- 26,668 Neurons per million input tokens;
- 204,805 Neurons per million output tokens.

The deterministic reserve assumes at most one input token per serialized UTF-8 byte, adds 2,048
tokens for provider chat-template/special-token overhead, and reserves the full 256-token output.
The maximum permitted request therefore reserves 534 Neurons. When complete token usage is returned,
it is converted with the same conservative rates; absent or partial usage leaves the reservation
untouched. The Cloudflare account must remain on the Workers Free plan: no paid fallback, Unified
Billing, prepaid gateway credits, or automatic upgrade is permitted.

## Primary sources captured

- Cloudflare model page:
  https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
- Cloudflare JSON Mode: https://developers.cloudflare.com/workers-ai/features/json-mode/
- Cloudflare data usage (last updated 2026-04-21):
  https://developers.cloudflare.com/workers-ai/platform/data-usage/
- Cloudflare pricing (last updated 2026-08-28):
  https://developers.cloudflare.com/workers-ai/platform/pricing/
- Meta Llama 3.3 Community License:
  https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE
- Meta Llama 3.3 Acceptable Use Policy:
  https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/USE_POLICY.md

Re-fetch all six sources before enabling production Gmail content or changing the model. Any change
to model identity, rate, free allocation, data use, storage behavior, or license/AUP fails closed and
requires a new dated snapshot plus review.
