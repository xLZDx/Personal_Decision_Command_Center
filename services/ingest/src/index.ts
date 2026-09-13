import type {
  ExportedHandler,
  Response as WorkersResponse,
  ScheduledController,
} from '@cloudflare/workers-types';

import { handleIngestRequest, handleScheduled } from './handler.js';
import type { IngestEnv } from './env.js';

export { handleIngestRequest, handleScheduled } from './handler.js';
export type { ScheduledRunResult } from './handler.js';
export { resolveSecret } from './env.js';
export type { IngestEnv, DispatchMessage } from './env.js';

/**
 * The only place this service's code touches the Workers-specific `Request`/`Response` types:
 * `ExportedHandler<Env>` requires them, but `handleIngestRequest` is written against the global
 * (Node/undici) `Request`/`Response` types instead, so its tests can construct a plain `Request`
 * with no Workers-specific fields. The two are the SAME runtime object under both Node and the
 * Workers runtime -- this cast bridges a type-declaration gap, not a real behavioral difference.
 */
export default {
  fetch(request, env) {
    return handleIngestRequest(
      request as unknown as Request,
      env,
    ) as unknown as Promise<WorkersResponse>;
  },
  async scheduled(_controller: ScheduledController, env) {
    await handleScheduled(env);
  },
} satisfies ExportedHandler<IngestEnv>;
