import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { withDORetry } from '@kilocode/worker-utils';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { STS_SESSION_SYNC_INTERNAL_CALL } from '@kilocode/sts-contracts';
import {
  createInternalServiceReceiver,
  type InternalReceiverEnv,
  type InternalRouteContract,
} from '@kilocode/worker-utils/internal-service-receiver';
import { Hono, type Context } from 'hono';
import { userIDSchema } from './protocol';

import { getTenantStub } from './dos/SessionSyncTenantDO';
import type { Env } from './env';
import { requestContext } from './request-context';
import { readSessionSyncSecret } from './secrets';

export const internal = new Hono<{ Bindings: Env }>();

/** `POST /internal/users/:userID/erase`, sent only by the web app's account deletion. */
const USER_ERASE_ROUTE: InternalRouteContract = {
  label: 'user_erase',
  scope: STS_SESSION_SYNC_INTERNAL_CALL.scope,
  workloads: ['web'],
  legacyHeader: 'X-Internal-Secret',
};

export const internalReceiver = createInternalServiceReceiver({
  receiver: 'session-sync',
  audience: STS_SESSION_SYNC_INTERNAL_CALL.audience,
  routes: [USER_ERASE_ROUTE],
});

/** The legacy check, unchanged: the shared secret in `X-Internal-Secret`. */
async function legacyRefusal(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const provided = c.req.header('X-Internal-Secret');
  if (!provided) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const expected = await readSessionSyncSecret(c.env, 'INTERNAL_API_SECRET', requestContext(c));
    if (
      !expected ||
      Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    observeInternalAuth(
      'session-sync',
      USER_ERASE_ROUTE.label,
      'legacy_shared_secret',
      callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
    );
  } catch (error) {
    console.error('session-sync internal auth unavailable', {
      error: error instanceof Error ? error.name : typeof error,
    });
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  return null;
}

internal.post('/users/:userID/erase', async c => {
  // `INTERNAL_CREDENTIAL_ACCEPT` selects the shared secret, an STS token or either.
  const receiverEnv: Env & InternalReceiverEnv = c.env;
  const refusal = await internalReceiver.admit(
    c.req.raw,
    receiverEnv,
    USER_ERASE_ROUTE,
    () => legacyRefusal(c),
    { waitUntil: promise => c.executionCtx.waitUntil(promise) }
  );
  if (refusal !== null) return refusal;
  const userID = userIDSchema.safeParse(c.req.param('userID'));
  if (!userID.success) return c.json({ error: 'Invalid user ID' }, 400);
  const result = await withDORetry(
    () => getTenantStub(c.env, { type: 'user', id: userID.data }),
    async stub => await stub.eraseUser({ userID: userID.data }),
    'SessionSyncTenantDO.eraseUser'
  );
  return result.ok ? c.json({ accepted: true }, 202) : c.json({ error: result.error.code }, 503);
});
