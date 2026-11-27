import { backendAuthMiddleware } from '@kilocode/worker-utils';
import type { HonoEnv } from './hono-env';
import { readAutoRoutingBenchmarkSecret } from './secrets';

export const authMiddleware = backendAuthMiddleware<HonoEnv>(c =>
  readAutoRoutingBenchmarkSecret(c.env, 'INTERNAL_API_SECRET')
);
