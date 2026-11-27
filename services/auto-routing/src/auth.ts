import { backendAuthMiddleware } from '@kilocode/worker-utils';
import type { HonoEnv } from './hono-env';
import { readAutoRoutingSecret } from './secrets';

export const authMiddleware = backendAuthMiddleware<HonoEnv>(c =>
  readAutoRoutingSecret(c.env, 'INTERNAL_API_SECRET')
);
