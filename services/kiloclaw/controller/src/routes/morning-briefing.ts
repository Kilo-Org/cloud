import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';
import type { Supervisor } from '../supervisor';

const MORNING_BRIEFING_PREFIX = '/api/plugins/kiloclaw-morning-briefing';

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

async function proxyMorningBriefingRoute(params: {
  supervisor: Supervisor;
  gatewayToken: string;
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
}): Promise<Response> {
  if (params.supervisor.getState() !== 'running') {
    return new Response(JSON.stringify({ error: 'Gateway not running' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    return await fetch(`http://127.0.0.1:3001${MORNING_BRIEFING_PREFIX}${params.path}`, {
      method: params.method,
      headers: {
        authorization: `Bearer ${params.gatewayToken}`,
        'content-type': 'application/json',
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    });
  } catch (error) {
    console.error('[controller] morning briefing proxy failed:', error);
    return new Response(JSON.stringify({ error: 'Failed to reach gateway' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export function registerMorningBriefingRoutes(
  app: Hono,
  supervisor: Supervisor,
  expectedToken: string
): void {
  app.use('/_kilo/morning-briefing/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/_kilo/morning-briefing/status', async c => {
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/status',
      method: 'GET',
    });
    return response;
  });

  app.post('/_kilo/morning-briefing/enable', async c => {
    const body = await readJsonBody(c);
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/enable',
      method: 'POST',
      body,
    });
    return response;
  });

  app.post('/_kilo/morning-briefing/disable', async c => {
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/disable',
      method: 'POST',
      body: {},
    });
    return response;
  });

  app.post('/_kilo/morning-briefing/run', async c => {
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/run',
      method: 'POST',
      body: {},
    });
    return response;
  });

  app.get('/_kilo/morning-briefing/read/today', async c => {
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/read/today',
      method: 'GET',
    });
    return response;
  });

  app.get('/_kilo/morning-briefing/read/yesterday', async c => {
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/read/yesterday',
      method: 'GET',
    });
    return response;
  });
}
