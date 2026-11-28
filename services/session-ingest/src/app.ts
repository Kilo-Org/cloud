import { timingSafeEqual } from '@kilocode/encryption';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sessionIdSchema } from '@kilocode/session-ingest-contracts';
import type { Env } from './env';
import { readSessionIngestSecret } from './secrets';
import { requestContext } from './request-context';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { z } from 'zod';

import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { cloudAgentSessionScopeApi } from './routes/cloud-agent-session-scope';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import { getSessionExport } from './services/session-export';
import { resolveSessionShareToken } from './services/session-share-token';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { withDORetry } from '@kilocode/worker-utils';
import {
  RESOURCE_METADATA_PATH,
  createInvalidateAuth,
  protectedResourceMetadata,
} from './session-access-invalidate-auth';

const invalidateSessionAccessSchema = z.object({
  kiloUserId: z.string().min(1),
  organizationId: z.uuid(),
});

async function hasValidInternalSecret(
  c: {
    req: { header(name: string): string | undefined };
    env: Env;
  },
  ctx?: SecretsExecutionContext
): Promise<boolean> {
  const provided = c.req.header('X-Internal-Secret');
  const expected = await readSessionIngestSecret(c.env, 'INTERNAL_API_SECRET', ctx);
  if (!provided || !expected || !timingSafeEqual(provided, expected)) return false;
  observeInternalAuth(
    'session-ingest',
    'cloud_agent_internal',
    'legacy_shared_secret',
    callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
  );
  return true;
}

type AppEnv = {
  Bindings: Env;
  Variables: { user_id: string; deletionAudience?: boolean };
};

const requireValidInternalSecret = createMiddleware<AppEnv>(async (c, next) => {
  let isValid: boolean;
  try {
    isValid = await hasValidInternalSecret(c, requestContext(c));
  } catch (error) {
    console.error('Auth infrastructure failure', {
      operation: 'internal-api-secret-get',
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
  }
  if (!isValid) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  return next();
});

/**
 * The invalidation route's guard: the shared secret, or under
 * `SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT` web's STS token
 * (`session-access-invalidate-auth.ts`). The other internal routes keep the shared secret.
 */
const requireSessionAccessInvalidate = createInvalidateAuth<AppEnv>(requireValidInternalSecret);

export const app = new Hono<AppEnv>();

// The RFC 9728 document the invalidation route's STS challenge names, served only while an STS
// mode is configured; otherwise the ordinary 404.
app.get(
  RESOURCE_METADATA_PATH,
  async (c, next) => protectedResourceMetadata(c.env) ?? (await next())
);

// Protect all /api routes with Kilo user API JWT auth.
app.use('/api/*', kiloJwtAuthMiddleware);
app.route('/api', api);

// Scoped session routes are internet-reachable through this Worker hostname. The
// internal secret authenticates the proxy; the JWT identifies the owning user.
app.use('/internal/cloud-agent/v1/*', kiloJwtAuthMiddleware);
app.use('/internal/cloud-agent/v1/*', requireValidInternalSecret);
app.route('/internal/cloud-agent/v1', cloudAgentSessionScopeApi);

// Public session endpoint: resolve the purpose-bound share token, then return
// the public transcript for the current session generation.
app.get('/session/:shareToken', async c => {
  const sharedSession = await resolveSessionShareToken(
    c.env,
    c.req.param('shareToken'),
    undefined,
    requestContext(c)
  );
  if (!sharedSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404, {
      'cache-control': 'no-store',
    });
  }

  const stream = await withDORetry(
    () =>
      getSessionIngestDO(c.env, {
        kiloUserId: sharedSession.kiloUserId,
        sessionId: sharedSession.sessionId,
      }),
    s =>
      sharedSession.contentCutoffMs === null
        ? s.getLiveSharedSessionStream()
        : s.getSharedSessionStream({
            publicId: sharedSession.publicId,
            ingestedBeforeMs: sharedSession.contentCutoffMs,
          }),
    'SessionIngestDO.getSharedSessionStream'
  );

  return c.body(stream, 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
});

app.get('/session/:shareToken/metadata', async c => {
  const sharedSession = await resolveSessionShareToken(
    c.env,
    c.req.param('shareToken'),
    undefined,
    requestContext(c)
  );
  if (!sharedSession) {
    return c.json({ success: false, error: 'session_not_found' }, 404, {
      'cache-control': 'no-store',
    });
  }

  return c.json(
    {
      success: true,
      title: sharedSession.title,
      owner_name: sharedSession.ownerName,
      git_url: sharedSession.gitUrl,
      git_branch: sharedSession.gitBranch,
      created_at: new Date(sharedSession.createdAt).toISOString(),
    },
    200,
    { 'cache-control': 'no-store' }
  );
});

app.post('/internal/session-access/invalidate', requireSessionAccessInvalidate, async c => {
  const parsed = invalidateSessionAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  await withDORetry(
    () => getSessionAccessCacheDO(c.env, { kiloUserId: parsed.data.kiloUserId }),
    sessionCache => sessionCache.invalidateOrganization(parsed.data.organizationId),
    'SessionAccessCacheDO.invalidateOrganization'
  );

  await getUserConnectionDO(c.env, { kiloUserId: parsed.data.kiloUserId }).closeViewerSockets();

  return c.body(null, 204);
});

// Internal route for service-binding HTTP fetch (secret-protected)
app.get('/internal/session/:sessionId/export', requireValidInternalSecret, async c => {
  const kiloUserId = c.req.header('X-Kilo-User-Id');
  if (!kiloUserId) return c.json({ success: false, error: 'Missing X-Kilo-User-Id' }, 400);

  const parsed = sessionIdSchema.safeParse(c.req.param('sessionId'));
  if (!parsed.success) return c.json({ success: false, error: 'Invalid sessionId' }, 400);

  const result = await getSessionExport(c.env, parsed.data, kiloUserId);
  if (result.status !== 'ok') return c.json({ success: false, error: 'Session not found' }, 404);

  return c.body(result.stream, 200, { 'content-type': 'application/json; charset=utf-8' });
});
