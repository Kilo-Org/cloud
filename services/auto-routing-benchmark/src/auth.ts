import { backendAuthMiddleware } from '@kilocode/worker-utils';
import type { HonoEnv } from './hono-env';

export const authMiddleware = backendAuthMiddleware<HonoEnv>(
  c => c.env.INTERNAL_API_SECRET_PROD.get(),
  { receiver: 'auto-routing-benchmark', route: 'admin_and_client' }
);
