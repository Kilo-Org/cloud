import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { OPENCLAW_PORT } from '../config';

/**
 * Public routes - no authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /health - Health check endpoint
publicRoutes.get('/health', c => {
  return c.json({
    status: 'ok',
    service: 'kiloclaw',
    gateway_port: OPENCLAW_PORT,
  });
});

export { publicRoutes };
