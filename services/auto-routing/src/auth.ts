import { backendAuthMiddleware } from '@kilocode/worker-utils';
import type { HonoEnv } from './hono-env';
import { readAutoRoutingSecret, requestContext } from './secrets';

export const authMiddleware = backendAuthMiddleware<HonoEnv>(
  c => readAutoRoutingSecret(c.env, 'INTERNAL_API_SECRET', requestContext(c)),
  {
    receiver: 'auto-routing',
    // The guard covers the admin pages and the decision route.
    route: c => (c.req.path.startsWith('/admin/') ? 'admin' : 'decide'),
  }
);
