// Empirical Cloudflare Free-plan CPU probe. See ../README.md for why this measures work units
// rather than milliseconds: Date.now() does not advance during pure computation inside a Worker,
// so self-timed millisecond figures from inside the loop are meaningless.
//
// The platform reports the real CPU time (wrangler tail + dashboard Metrics). This code's only
// job is to burn a known, deterministic amount of CPU and make the start/finish boundary visible
// in the logs.

const LADDER = [1e3, 1e4, 1e5, 1e6, 3e6, 1e7, 3e7];

async function burn(rounds) {
  // SHA-256 over a small buffer, re-fed into itself. Chosen because it is CPU-bound, cannot be
  // optimized away (each round depends on the previous digest), and uses no I/O -- an I/O wait
  // would not count against the active-CPU budget being measured.
  let buf = new TextEncoder().encode('pdos-cpu-probe');
  for (let i = 0; i < rounds; i++) {
    buf = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  }
  return buf[0];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      // Enqueue the whole ladder; each message is consumed in its own invocation.
      for (const target of LADDER) {
        await env.PROBE_QUEUE.send({ target, ladder: 'queue-consumer' });
      }
      return new Response(
        `enqueued ${LADDER.length} probe messages: ${LADDER.join(', ')}\n` +
          `watch: npx wrangler tail pdos-cpu-probe --format pretty\n`,
        { headers: { 'content-type': 'text/plain' } },
      );
    }

    if (url.pathname === '/http-ladder') {
      // Same ladder, but in the ordinary HTTP invocation path, to establish this account's
      // baseline Worker CPU budget for comparison with the consumer figure.
      const results = [];
      for (const target of LADDER) {
        console.log(`PROBE_START ladder=http target=${target}`);
        try {
          await burn(target);
          console.log(`PROBE_DONE ladder=http target=${target}`);
          results.push(`${target}: DONE`);
        } catch (err) {
          // A CPU-limit termination is not catchable here -- the isolate is killed. This catch
          // only sees ordinary errors, and its presence must not be read as "CPU limits are
          // handled gracefully".
          console.log(`PROBE_ERROR ladder=http target=${target} err=${err}`);
          results.push(`${target}: ERROR ${err}`);
          break;
        }
      }
      return new Response(
        results.join('\n') +
          '\n\nNOTE: a target missing from this list entirely means the invocation was killed\n' +
          'before it could respond -- check wrangler tail for the CPU-exceeded exception.\n',
        { headers: { 'content-type': 'text/plain' } },
      );
    }

    return new Response(
      'pdos-cpu-probe\n\n' +
        '  GET /run          enqueue the escalating ladder for the QUEUE CONSUMER path\n' +
        '  GET /http-ladder  run the same ladder in the HTTP path for comparison\n\n' +
        'Read results from `wrangler tail` and the dashboard CPU-time metric, not from this\n' +
        "Worker's own timings -- see ../README.md.\n",
      { headers: { 'content-type': 'text/plain' } },
    );
  },

  async queue(batch, env) {
    // max_batch_size = 1, so this is one message per invocation by configuration.
    for (const msg of batch.messages) {
      const target = msg.body.target;
      console.log(`PROBE_START ladder=queue-consumer target=${target}`);
      await burn(target);
      // If this line never appears for a given target while PROBE_START did, that invocation
      // hit the CPU ceiling. That absence IS the measurement.
      console.log(`PROBE_DONE ladder=queue-consumer target=${target}`);
      msg.ack();
    }
  },
};
