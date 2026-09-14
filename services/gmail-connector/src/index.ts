import type { ExportedHandler } from '@cloudflare/workers-types';

import { handleContentGatewayRequest } from './content-gateway.js';
import type { GmailConnectorEnv } from './env.js';

export { handleContentGatewayRequest } from './content-gateway.js';
export type { GmailConnectorEnv } from './env.js';

export default {
  fetch: handleContentGatewayRequest as unknown as NonNullable<
    ExportedHandler<GmailConnectorEnv>['fetch']
  >,
} satisfies ExportedHandler<GmailConnectorEnv>;
