import { backendAuthMiddleware } from '@kilocode/worker-utils';
import type { HonoEnv } from './hono-env';

export const authMiddleware = backendAuthMiddleware<HonoEnv>(async c =>
  c.env.HEADROOM_BEARER_TOKEN.get()
);
