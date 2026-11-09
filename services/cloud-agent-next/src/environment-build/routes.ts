import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { resolveSecret } from '../auth.js';
import type { HonoContext } from '../hono-context.js';
import {
  environmentBuildEventsSchema,
  environmentBuildResultSchema,
} from '../shared/environment-build-protocol.js';
import type { RunnerAuth, RunnerRefusal } from './coordinator.js';
import { parseRunnerBearer, verifyRunnerCredential } from './runner-credential.js';

/**
 * The build-specific control endpoint (plan: "The runner uses a build-specific
 * authenticated control endpoint"). Each request carries the signed runner
 * credential; the path must name the same environment and build, and the
 * coordinator checks the allocation and derived credential before acting. A
 * session credential can never pass here, and this route never reaches a
 * Sandbox DO.
 */

const MAX_BODY_BYTES = 256 * 1024;
const idSchema = z.string().uuid();

type RunnerContext = Context<HonoContext>;

function refusalResponse(c: RunnerContext, refusal: RunnerRefusal): Response {
  switch (refusal.refused) {
    case 'unauthorized':
      return c.json({ error: 'unauthorized' }, 401);
    case 'gone':
      return c.json({ error: 'build is not running' }, 410);
    case 'unavailable':
      return c.json({ error: 'temporarily unavailable' }, 503);
  }
}

async function authenticate(c: RunnerContext): Promise<RunnerAuth | Response> {
  const environmentId = idSchema.safeParse(c.req.param('environmentId'));
  const buildId = idSchema.safeParse(c.req.param('buildId'));
  if (!environmentId.success || !buildId.success) return c.json({ error: 'not found' }, 404);
  const token = parseRunnerBearer(c.req.header('authorization') ?? null);
  if (token === null) return c.json({ error: 'unauthorized' }, 401);
  const secret = await resolveSecret(c.env.NEXTAUTH_SECRET).catch(() => null);
  if (!secret) return c.json({ error: 'temporarily unavailable' }, 503);
  const claims = verifyRunnerCredential(token, secret);
  if (claims === null) return c.json({ error: 'unauthorized' }, 401);
  if (claims.environmentId !== environmentId.data || claims.buildId !== buildId.data) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return {
    environmentId: claims.environmentId,
    buildId: claims.buildId,
    allocationId: claims.allocationId,
    credential: claims.credential,
  };
}

async function readJson(c: RunnerContext): Promise<unknown> {
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('body too large');
  return JSON.parse(text) as unknown;
}

function coordinator(c: RunnerContext, environmentId: string) {
  return c.env.ENVIRONMENT_BUILD.getByName(environmentId);
}

export function registerEnvironmentBuildRoutes(app: Hono<HonoContext>): void {
  app.get('/environment-build/:environmentId/:buildId/input', async c => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const reply = await coordinator(c, auth.environmentId).runnerInput(auth);
    if ('refused' in reply) return refusalResponse(c, reply);
    return c.json(reply, 200, { 'cache-control': 'no-store' });
  });

  app.post('/environment-build/:environmentId/:buildId/events', async c => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    let events;
    try {
      events = environmentBuildEventsSchema.parse(await readJson(c));
    } catch {
      return c.json({ error: 'invalid events' }, 400);
    }
    const reply = await coordinator(c, auth.environmentId).runnerEvents(auth, events);
    if ('refused' in reply) return refusalResponse(c, reply);
    return c.json(reply);
  });

  app.post('/environment-build/:environmentId/:buildId/result', async c => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    let result;
    try {
      result = environmentBuildResultSchema.parse(await readJson(c));
    } catch {
      return c.json({ error: 'invalid result' }, 400);
    }
    const reply = await coordinator(c, auth.environmentId).runnerResult(auth, result);
    if (reply !== 'ok') return refusalResponse(c, reply);
    return c.json({ ok: true });
  });
}
