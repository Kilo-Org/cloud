import { backendAuthMiddleware } from '@kilocode/worker-utils';
import type { HonoEnv } from './hono-env';

export const authMiddleware = backendAuthMiddleware<HonoEnv>(
  c => c.env.INTERNAL_API_SECRET_PROD.get(),
  {
    receiver: 'auto-routing',
    // The guard covers the admin pages and the decision route.
    route: c => (c.req.path.startsWith('/admin/') ? 'admin' : 'decide'),
  }
);
