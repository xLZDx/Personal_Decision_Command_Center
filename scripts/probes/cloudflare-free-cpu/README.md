# Empirical Cloudflare Free-Plan CPU Probe

**G0 output E.** Answers one question with measurement instead of documentation:

> On the Workers **Free** plan, what active-CPU budget does a **Queue consumer** invocation
> actually get — the ~10ms of an ordinary Worker invocation, or the 30s/5min the Queues docs
> describe?

This matters because the whole event-processing design was rebuilt around the conservative
answer. See `core/adr/ADR-011-queue-consumer-runtime.md` and NB1 in
`governance/reviews/02-tdd-v0.2-adversarial-review.md`. If the real budget turns out larger, that
is margin — the architecture does not depend on it. If it is ~10ms, the design is already correct.

## Status

**NOT YET RUN.** No results exist. `RESULTS.md` is an empty template — do not read it as evidence.
Running this requires an operator-owned Cloudflare account on the **Free** plan; Claude does not
have and must not be given those credentials (`CLAUDE.md` §2).

## Why this probe measures work units, not milliseconds

Inside a Worker, `Date.now()` does **not** advance during pure computation — Cloudflare freezes
the clock between I/O operations as a timing-side-channel mitigation. A probe that busy-loops and
then reports `Date.now() - start` will report `0ms` no matter how much CPU it burned, and a naive
reading of that output would "prove" the consumer used no CPU at all. That is a broken instrument
producing exactly the answer you were hoping for.

So the probe instead:

1. Burns a **fixed, deterministic number of work units** (SHA-256 rounds over a small buffer) per
   message, escalating across messages: `1e3, 1e4, 1e5, 1e6, 3e6, 1e7, 3e7` rounds.
2. Logs `PROBE_START target=<rounds>` before the loop and `PROBE_DONE target=<rounds>` after it.
3. Lets Cloudflare's own platform report the CPU time — via `wrangler tail` (which surfaces the
   `Exceeded CPU time limit` exception) and via the Workers dashboard's per-invocation CPU-time
   metric, which is measured by the runtime rather than by the code under test.

The breaking point is the smallest `target` for which `PROBE_START` appears with no matching
`PROBE_DONE` and an `Exceeded CPU` error is logged. The dashboard's CPU-ms figure for the largest
`target` that *did* complete is the empirical budget.

## Cost safety

- The queue consumer is configured `max_retries = 0`, so a killed probe message is not retried.
  Without this, each CPU-exceeded message would retry and burn the Free plan's 10,000
  operations/day budget several times over (`core/adr/ADR-010-hard-zero-cost.md`).
- The full ladder is 7 messages ≈ 21 queue operations. Running it a dozen times is still
  negligible against the daily budget.
- Everything here is deployed to a throwaway Worker/queue named `pdos-cpu-probe*`. It touches no
  D1 database, no Gmail/Telegram credentials, and no project data.

## Operator run instructions

Prerequisites: Node.js, a Cloudflare account **on the Free plan** (a Paid account answers the
wrong question), and `npx wrangler login` completed.

```bash
cd scripts/probes/cloudflare-free-cpu

# 1. Create the probe queue (one time)
npx wrangler queues create pdos-cpu-probe

# 2. Deploy the probe worker (it is both the producer and the consumer)
npx wrangler deploy

# 3. In a second terminal, start streaming logs BEFORE triggering the ladder
npx wrangler tail pdos-cpu-probe --format pretty

# 4. Trigger the escalating ladder (7 messages)
curl "https://pdos-cpu-probe.<your-subdomain>.workers.dev/run"

# 5. Also run the same ladder through the plain HTTP path, for comparison:
#    this establishes the ordinary Worker budget on the same account, so the
#    consumer figure can be read as "same as / larger than an HTTP invocation".
curl "https://pdos-cpu-probe.<your-subdomain>.workers.dev/http-ladder"
```

Then, in the Cloudflare dashboard: **Workers & Pages -> pdos-cpu-probe -> Metrics**, read the
**CPU time** distribution (p50/p99 per invocation) for the run window.

Record everything in `RESULTS.md` — including the account plan, the date, and the raw
`wrangler tail` excerpt. **Do not record an inferred number.** If a step fails or the account
turns out not to be Free-plan, write that down instead; a probe that did not run is a fact, and a
fabricated measurement is the one outcome that would make this whole exercise worse than useless.

## Cleanup after the run

```bash
npx wrangler delete pdos-cpu-probe
npx wrangler queues delete pdos-cpu-probe
```
