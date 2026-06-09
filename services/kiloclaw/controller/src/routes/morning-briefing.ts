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
  // When true, a 404 from the in-container plugin is rewritten to a
  // controller-owned `morning_briefing_plugin_unavailable` (503) instead of
  // being passed through verbatim. Because this controller image registered
  // the `/_kilo/morning-briefing/*` routes, a 404 from the plugin can only
  // mean the OpenClaw `kiloclaw-morning-briefing` plugin has not finished
  // loading yet (common right after a redeploy onto a new image) — NOT that
  // the image is too old. Cloud's `isErrorUnknownRoute` treats a bare 404 as
  // "controller too old", so without this rewrite a transient plugin-load
  // gap surfaces to the user as a spurious "Upgrade Required" banner.
  //
  // Only `/status` opts in. It drives the dashboard card (and is the only
  // route whose warm-up handling cloud actually consumes). The mutation
  // routes are intentionally left as a verbatim 404 → cloud's existing
  // `isErrorUnknownRoute` → null path: cloud's mutation wrappers only
  // special-case that bare-404 signal, and the typed 503 code would be
  // stripped crossing the DO RPC boundary and surface as a generic 500.
  // The read routes are also left verbatim — their 404 is semantic
  // ("no briefing yet"), not a plugin-load signal.
  notFoundMeansPluginUnavailable?: boolean;
}): Promise<Response> {
  if (params.supervisor.getState() !== 'running') {
    return new Response(JSON.stringify({ error: 'Gateway not running' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:3001${MORNING_BRIEFING_PREFIX}${params.path}`, {
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

  if (params.notFoundMeansPluginUnavailable && response.status === 404) {
    return new Response(
      JSON.stringify({
        code: 'morning_briefing_plugin_unavailable',
        error: 'Morning Briefing plugin is still loading',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }

  return response;
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
      notFoundMeansPluginUnavailable: true,
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

  app.post('/_kilo/morning-briefing/onboarding-briefing', async c => {
    const body = await readJsonBody(c);
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/onboarding-briefing',
      method: 'POST',
      body,
    });
    return response;
  });

  app.post('/_kilo/morning-briefing/interests', async c => {
    const body = await readJsonBody(c);
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/interests',
      method: 'POST',
      body,
    });
    return response;
  });

  app.post('/_kilo/morning-briefing/user-location', async c => {
    const body = await readJsonBody(c);
    const response = await proxyMorningBriefingRoute({
      supervisor,
      gatewayToken: expectedToken,
      path: '/user-location',
      method: 'POST',
      body,
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
