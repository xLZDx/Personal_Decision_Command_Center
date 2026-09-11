# Cloudflare Free-Plan CPU Probe — Results

## STATUS: RUN. Ladder measurements below are real; dashboard CPU-ms figures are not yet captured.

Two of the three planned readings are in: the `wrangler tail` ladder for both the queue consumer
and the plain HTTP invocation. The third — the Workers dashboard's per-invocation CPU-time metric
(p50/p99) — has not been read yet. Nothing below is inferred from that missing reading; where a
number would depend on it, this file says "not yet captured" rather than filling in a guess.

`core/adr/ADR-011-queue-consumer-runtime.md` rested on the conservative _assumption_ of a ~10ms
budget. This run is the first empirical evidence for or against it, and it **confirms** the
assumption (see Conclusion).

---

## Run record

```
Run date: 2026-09-11
Cloudflare account plan: Free (fresh signup for this probe; not independently re-verified against
  the dashboard's own plan label -- taken from the operator's account creation, not a paid-tier
  account being reused)
Wrangler version: not captured (invoked via `npx wrangler`; exact resolved version not logged)
Worker name / subdomain: pdos-cpu-probe / pdos-korostelev.workers.dev
```

### Queue-consumer ladder (`GET /run`)

| target (SHA-256 rounds) | PROBE_START seen | PROBE_DONE seen | dashboard CPU ms | outcome                |
| ----------------------- | ---------------- | --------------- | ---------------- | ---------------------- |
| 1e3                     | yes              | yes             | not yet captured | completed              |
| 1e4                     | yes              | yes             | not yet captured | completed              |
| 1e5                     | yes              | yes             | not yet captured | completed              |
| 1e6                     | yes              | **no**          | n/a — killed     | **Exceeded CPU Limit** |
| 3e6                     | yes              | no              | n/a — killed     | Exceeded CPU Limit     |
| 1e7                     | yes              | no              | n/a — killed     | Exceeded CPU Limit     |
| 3e7                     | yes              | no              | n/a — killed     | Exceeded CPU Limit     |

Each of the four failing messages ran as its own queue invocation (`max_retries = 0`, per the
probe's design), so all seven rungs were actually attempted — the failures are four independent
data points, not one failure blocking the rest of the ladder.

### HTTP ladder (`GET /http-ladder`) — same account, for comparison

| target (SHA-256 rounds) | PROBE_START seen | PROBE_DONE seen | dashboard CPU ms | outcome                                |
| ----------------------- | ---------------- | --------------- | ---------------- | -------------------------------------- |
| 1e3                     | yes              | yes             | not yet captured | completed                              |
| 1e4                     | yes              | yes             | not yet captured | completed                              |
| 1e5                     | yes              | yes             | not yet captured | completed                              |
| 1e6                     | yes              | **no**          | n/a — killed     | **worker exceeded CPU time limit**     |
| 3e6                     | not reached      | not reached     | —                | not reached (invocation killed at 1e6) |
| 1e7                     | not reached      | not reached     | —                | not reached (invocation killed at 1e6) |
| 3e7                     | not reached      | not reached     | —                | not reached (invocation killed at 1e6) |

Unlike the queue ladder, the HTTP ladder runs all seven rungs **inside one HTTP invocation** — so
once the worker was killed at `target=1000000`, the request itself terminated and rungs 3e6/1e7/3e7
were never attempted in this run at all. This is a design property of the probe's `/http-ladder`
route, not a measurement gap.

### Raw `wrangler tail` excerpt

```
Successfully created tail, expires at 2026-09-11T16:19:43Z
Connected to pdos-cpu-probe, waiting for logs...
GET https://pdos-cpu-probe.pdos-korostelev.workers.dev/run - Ok @ 9/11/2026, 1:24:38 PM
Queue pdos-cpu-probe (1 message) - Ok @ 9/11/2026, 1:24:41 PM
  (log) PROBE_START ladder=queue-consumer target=1000
  (log) PROBE_DONE ladder=queue-consumer target=1000
Queue pdos-cpu-probe (1 message) - Ok @ 9/11/2026, 1:24:42 PM
  (log) PROBE_START ladder=queue-consumer target=10000
  (log) PROBE_DONE ladder=queue-consumer target=10000
Queue pdos-cpu-probe (1 message) - Ok @ 9/11/2026, 1:24:42 PM
  (log) PROBE_START ladder=queue-consumer target=100000
  (log) PROBE_DONE ladder=queue-consumer target=100000
Queue pdos-cpu-probe (1 message) - Exceeded CPU Limit @ 9/11/2026, 1:24:43 PM
  (log) PROBE_START ladder=queue-consumer target=1000000
Queue pdos-cpu-probe (1 message) - Exceeded CPU Limit @ 9/11/2026, 1:24:45 PM
  (log) PROBE_START ladder=queue-consumer target=3000000
Queue pdos-cpu-probe (1 message) - Exceeded CPU Limit @ 9/11/2026, 1:24:46 PM
  (log) PROBE_START ladder=queue-consumer target=10000000
Queue pdos-cpu-probe (1 message) - Exceeded CPU Limit @ 9/11/2026, 1:24:46 PM
  (log) PROBE_START ladder=queue-consumer target=30000000
GET https://pdos-cpu-probe.pdos-korostelev.workers.dev/http-ladder - Exceeded CPU Limit @ 9/11/2026, 1:25:35 PM
  (log) PROBE_START ladder=http target=1000
  (log) PROBE_DONE ladder=http target=1000
  (log) PROBE_START ladder=http target=10000
  (log) PROBE_DONE ladder=http target=10000
  (log) PROBE_START ladder=http target=100000
  (log) PROBE_DONE ladder=http target=100000
  (log) PROBE_START ladder=http target=1000000
X [ERROR] Error: Worker exceeded CPU time limit.
```

### Conclusion

```
Empirical queue-consumer budget: breaks between 1e5 (completes) and 1e6 (killed) SHA-256 rounds.
Empirical HTTP-invocation budget: breaks at the SAME point -- between 1e5 and 1e6 rounds.
Do they differ? No. Same breaking point observed for both, on the same account, in the same
  ~1-minute window.
Does this confirm or refute ADR-011's conservative 10ms assumption? CONFIRMS. The Queue consumer on
  this Free-plan account gets the same tiny CPU budget as an ordinary HTTP invocation -- not the
  30s / 5min / 15min figures that appeared, contradictorily, across different Cloudflare
  documentation pages (recorded in docs/architecture/EXTERNAL_ASSUMPTIONS.md section C, "The NB1
  contradiction"). NB1 is resolved in favor of the conservative reading.
Does the architecture need to change (i.e. must the HTTP pull consumer fallback be taken)? No
  forced change: the design was already built around the ~10ms assumption this measurement
  confirms. The pull-consumer fallback (ADR-011) stays the answer for any future step that needs
  MORE than ~10ms of consumer CPU on Free -- this measurement does not make that case, it removes
  the uncertainty about which case applies today.
```

### Still outstanding

The Workers dashboard's per-invocation CPU-time metric (Workers & Pages -> pdos-cpu-probe ->
Metrics -> CPU time, p50/p99 for this run's window) has not been read yet. It would give an actual
millisecond figure for the rungs that completed (1e3-1e5), rather than only the pass/fail boundary
this run already establishes. Not blocking: the boundary itself is sufficient to confirm ADR-011.

### If the probe could not be run

N/A -- it ran.
