# Cloudflare Free-Plan CPU Probe — Results

## STATUS: NOT RUN. THIS FILE CONTAINS NO MEASUREMENTS.

Everything below is an empty template. Any number appearing in it that is not accompanied by a
run date, an account-plan confirmation and a raw `wrangler tail` excerpt is **not evidence** and
must not be cited in a gate closure, an ADR, or a report.

`core/adr/ADR-011-queue-consumer-runtime.md` currently rests on the conservative *assumption* of a
10ms budget, explicitly recorded as an assumption. It stays an assumption until this file says
otherwise.

---

## Run record template

```
Run date:
Cloudflare account plan (must be FREE for this to answer the right question):
Wrangler version:
Worker name / region:
```

### Queue-consumer ladder (`GET /run`)

| target (SHA-256 rounds) | PROBE_START seen | PROBE_DONE seen | dashboard CPU ms | outcome |
|---|---|---|---|---|
| 1e3 | | | | |
| 1e4 | | | | |
| 1e5 | | | | |
| 1e6 | | | | |
| 3e6 | | | | |
| 1e7 | | | | |
| 3e7 | | | | |

### HTTP ladder (`GET /http-ladder`) — same account, for comparison

| target (SHA-256 rounds) | PROBE_START seen | PROBE_DONE seen | dashboard CPU ms | outcome |
|---|---|---|---|---|
| 1e3 | | | | |
| 1e4 | | | | |
| 1e5 | | | | |
| 1e6 | | | | |
| 3e6 | | | | |
| 1e7 | | | | |
| 3e7 | | | | |

### Raw `wrangler tail` excerpt

```
(paste verbatim -- including any "Exceeded CPU time limit" exception lines)
```

### Conclusion

```
Empirical queue-consumer budget:
Empirical HTTP-invocation budget:
Do they differ?
Does this confirm or refute ADR-011's conservative 10ms assumption?
Does the architecture need to change (i.e. must the HTTP pull consumer fallback be taken)?
```

### If the probe could not be run

State why, precisely (no Free-plan account available, deploy failed, tail unavailable, etc.), and
what remains unknown as a result. `core/RISK_REGISTER.md` R8 stays open in that case — an
unverifiable assumption is not the same as a verified one, and G0 closure must say which it is.
