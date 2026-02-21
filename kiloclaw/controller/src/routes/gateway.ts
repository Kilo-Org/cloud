import type { Hono } from 'hono';
import type { Supervisor } from '../supervisor';

function getBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(/\s+/, 2);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

export function registerGatewayRoutes(
  app: Hono,
  supervisor: Supervisor,
  expectedToken: string
): void {
  app.use('/gateway/*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    const token = getBearerToken(authHeader);
    if (!token || token !== expectedToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/gateway/status', c => {
    const stats = supervisor.getStats();
    return c.json({
      state: stats.state,
      pid: stats.pid,
      uptime: stats.uptime,
      restarts: stats.restarts,
      lastExit: stats.lastExit,
    });
  });

  app.post('/gateway/start', async c => {
    try {
      const started = await supervisor.start();
      if (!started) {
        return c.json({ error: 'Gateway already running or starting' }, 409);
      }
      return c.json({ ok: true });
    } catch (error) {
      console.error('[controller] /gateway/start failed:', error);
      return c.json({ error: 'Failed to start gateway' }, 500);
    }
  });

  app.post('/gateway/stop', async c => {
    try {
      await supervisor.stop();
      return c.json({ ok: true });
    } catch (error) {
      console.error('[controller] /gateway/stop failed:', error);
      return c.json({ error: 'Failed to stop gateway' }, 500);
    }
  });

  app.post('/gateway/restart', async c => {
    try {
      const restarted = await supervisor.restart();
      if (!restarted) {
        return c.json({ error: 'Gateway is shutting down' }, 409);
      }
      return c.json({ ok: true });
    } catch (error) {
      console.error('[controller] /gateway/restart failed:', error);
      return c.json({ error: 'Failed to restart gateway' }, 500);
    }
  });
}
