import { timingSafeEqual } from '@kilocode/encryption';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { verifySessionAccessInvalidationCredential } from '@kilocode/worker-utils/session-access-invalidation-credential';
import {
  isLegacyInternalSessionAuthEnabled,
  type InternalSessionAuthMethod,
} from '@kilocode/worker-utils/internal-session-auth';
import type { Env } from './env';
import { z } from 'zod';

import { kiloJwtAuthMiddleware } from './middleware/kilo-jwt-auth';
import { api } from './routes/api';
import { cloudAgentSessionScopeApi } from './routes/cloud-agent-session-scope';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import { resolveSessionShareToken } from './services/session-share-token';
import { withDORetry } from '@kilocode/worker-utils';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const invalidateSessionAccessSchema = z.object({
  kiloUserId: z.string().min(1),
  organizationId: z.uuid(),
});

function logInvalidationAudit(
  outcome: 'ok' | 'unauthorized' | 'forbidden' | 'invalid_request' | 'unavailable' | 'failed',
  status: number,
  startedAt: number,
  authMethod?: InternalSessionAuthMethod
): void {
  console.log(
    JSON.stringify({
      type: 'session_access_invalidation',
      outcome,
      status,
      durationMs: Date.now() - startedAt,
      authMethod,
    })
  );
}

async function hasValidInternalSecret(c: {
  req: { header(name: string): string | undefined };
  env: Env;
}): Promise<boolean> {
  const provided = c.req.header('X-Internal-Secret');
  const expected = await c.env.INTERNAL_API_SECRET_PROD.get();
  if (!provided || !expected) return false;

  return timingSafeEqual(provided, expected);
}

const requireValidInternalSecret = createMiddleware<{
  Bindings: Env;
  Variables: { user_id: string; deletionAudience?: boolean };
}>(async (c, next) => {
  let isValid: boolean;
  try {
    isValid = await hasValidInternalSecret(c);
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

export const app = new Hono<{
  Bindings: Env;
  Variables: {
    user_id: string;
    deletionAudience?: boolean;
  };
}>();

// Protect all /api routes with Kilo user API JWT auth.
app.use('/api/*', kiloJwtAuthMiddleware);
app.route('/api', api);

// Scoped session routes are internet-reachable through this Worker hostname. The
// internal secret authenticates the proxy; the JWT identifies the owning user.
app.use('/internal/cloud-agent/v1/*', kiloJwtAuthMiddleware);
app.use('/internal/cloud-agent/v1/*', requireValidInternalSecret);
app.route('/internal/cloud-agent/v1', cloudAgentSessionScopeApi);

// Public session endpoint: resolve the purpose-bound share token, then return
// all ingested DO events for the current session generation.
app.get('/session/:shareToken', async c => {
  const sharedSession = await resolveSessionShareToken(c.env, c.req.param('shareToken'));
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
    s => s.getAllStream(),
    'SessionIngestDO.getAllStream'
  );

  return c.body(stream, 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
});

app.get('/session/:shareToken/metadata', async c => {
  const sharedSession = await resolveSessionShareToken(c.env, c.req.param('shareToken'));
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

app.post('/internal/session-access/invalidate', async c => {
  const startedAt = Date.now();
  const authMethod = c.req.raw.headers.has('authorization') ? 'bearer' : 'legacy';
  let bearerAuthority: { userId: string; organizationId: string | undefined } | undefined;
  if (authMethod === 'bearer') {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) {
      logInvalidationAudit('unauthorized', 401, startedAt);
      return c.json({ success: false, error: 'Unauthorized' }, 401, NO_STORE);
    }
    let expectedSecret: string;
    try {
      const secret = await c.env.SESSION_INGEST_INVALIDATION_SIGNING_SECRET_PROD.get();
      if (!secret) {
        logInvalidationAudit('unavailable', 503, startedAt);
        return c.json({ success: false, error: 'Service temporarily unavailable' }, 503, NO_STORE);
      }
      expectedSecret = secret;
    } catch (error) {
      console.error('Auth infrastructure failure', {
        operation: 'session-access-invalidation-secret-get',
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      logInvalidationAudit('unavailable', 503, startedAt);
      return c.json({ success: false, error: 'Service temporarily unavailable' }, 503, NO_STORE);
    }

    const credential = await verifySessionAccessInvalidationCredential({
      token,
      secret: expectedSecret,
    });
    if (!credential.ok) {
      logInvalidationAudit('unauthorized', 401, startedAt);
      return c.json({ success: false, error: 'Unauthorized' }, 401, NO_STORE);
    }
    bearerAuthority = credential;
  } else {
    if (
      !isLegacyInternalSessionAuthEnabled(c.env.INTERNAL_SESSION_AUTH_LEGACY_ENABLED) ||
      !c.req.header('X-Internal-Secret')
    ) {
      logInvalidationAudit('unauthorized', 401, startedAt);
      return c.json({ success: false, error: 'Unauthorized' }, 401, NO_STORE);
    }
    try {
      if (!(await hasValidInternalSecret(c))) {
        logInvalidationAudit('unauthorized', 401, startedAt);
        return c.json({ success: false, error: 'Unauthorized' }, 401, NO_STORE);
      }
    } catch (error) {
      console.error('Auth infrastructure failure', {
        operation: 'session-access-legacy-secret-get',
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      logInvalidationAudit('unavailable', 503, startedAt);
      return c.json({ success: false, error: 'Service temporarily unavailable' }, 503, NO_STORE);
    }
  }

  const parsed = invalidateSessionAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    logInvalidationAudit('invalid_request', 400, startedAt);
    return c.json(
      { success: false, error: 'Invalid request', issues: parsed.error.issues },
      400,
      NO_STORE
    );
  }

  if (
    bearerAuthority &&
    (bearerAuthority.userId !== parsed.data.kiloUserId ||
      bearerAuthority.organizationId !== parsed.data.organizationId)
  ) {
    logInvalidationAudit('forbidden', 403, startedAt);
    return c.json({ success: false, error: 'Forbidden' }, 403, NO_STORE);
  }

  try {
    await withDORetry(
      () => getSessionAccessCacheDO(c.env, { kiloUserId: parsed.data.kiloUserId }),
      sessionCache => sessionCache.invalidateOrganization(parsed.data.organizationId),
      'SessionAccessCacheDO.invalidateOrganization'
    );

    await getUserConnectionDO(c.env, { kiloUserId: parsed.data.kiloUserId }).closeViewerSockets();
  } catch (error) {
    logInvalidationAudit('failed', 500, startedAt);
    throw error;
  }

  logInvalidationAudit('ok', 204, startedAt, authMethod);
  return c.body(null, 204, NO_STORE);
});
