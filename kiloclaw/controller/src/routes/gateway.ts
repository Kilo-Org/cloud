import os from 'node:os';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';

// shared-cpu-2x gives ~6% of 2 physical cores, so even modest load
// averages represent heavy pressure. After boot completes, an idle
// system sits near 0. A threshold of 0.1 ensures boot CPU work has
// fully subsided before we tell the frontend it's safe to proceed.
const LOAD_SETTLED_THRESHOLD = 0.1;

function loadFields(): { loadAverage: number[]; settled: boolean } {
  const loadAverage = os.loadavg();
  return { loadAverage, settled: loadAverage[0] < LOAD_SETTLED_THRESHOLD };
}

export function getBearerToken(header: string | undefined): string | null {
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
  app.use('/_kilo/gateway/*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    const token = getBearerToken(authHeader);
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/_kilo/gateway/status', c => {
    const stats = supervisor.getStats();
    return c.json({
      state: stats.state,
      pid: stats.pid,
      uptime: stats.uptime,
      restarts: stats.restarts,
      lastExit: stats.lastExit,
    });
  });

  app.post('/_kilo/gateway/start', async c => {
    try {
      const started = await supervisor.start();
      if (!started) {
        return c.json({ error: 'Gateway already running or starting' }, 409);
      }
      return c.json({ ok: true });
    } catch (error) {
      console.error('[controller] /_kilo/gateway/start failed:', error);
      return c.json({ error: 'Failed to start gateway' }, 500);
    }
  });

  app.post('/_kilo/gateway/stop', async c => {
    try {
      await supervisor.stop();
      return c.json({ ok: true });
    } catch (error) {
      console.error('[controller] /_kilo/gateway/stop failed:', error);
      return c.json({ error: 'Failed to stop gateway' }, 500);
    }
  });

  app.get('/_kilo/gateway/ready', async c => {
    if (supervisor.getState() !== 'running') {
      return c.json({ ready: false, error: 'Gateway not running', ...loadFields() }, 503);
    }
    try {
      const res = await fetch('http://127.0.0.1:3001/ready');
      const body = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = { raw: body };
      }
      const envelope =
        typeof json === 'object' && json !== null
          ? { ...json, ...loadFields() }
          : { raw: json, ...loadFields() };
      return c.json(envelope, res.ok ? 200 : 503);
    } catch (error) {
      console.error('[controller] /_kilo/gateway/ready failed:', error);
      return c.json({ ready: false, error: 'Failed to reach gateway', ...loadFields() }, 502);
    }
  });

  app.post('/_kilo/gateway/restart', async c => {
    try {
      const restarted = await supervisor.restart();
      if (!restarted) {
        return c.json({ error: 'Gateway is shutting down' }, 409);
      }
      return c.json({ ok: true });
    } catch (error) {
      console.error('[controller] /_kilo/gateway/restart failed:', error);
      return c.json({ error: 'Failed to restart gateway' }, 500);
    }
  });
}
