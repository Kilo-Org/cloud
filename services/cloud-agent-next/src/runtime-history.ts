import type { Context } from 'hono';
import { sessionIdSchema } from '@kilocode/session-ingest-contracts';
import type { HonoContext } from './hono-context.js';
import { isControlSession } from './session-identity.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import { withDORetry } from './utils/do-retry.js';
import { readBoundedBody } from './utils/read-bounded-body.js';
import type { RuntimeProxyHandleClaims } from './runtime-credential-proxy.js';
import {
  decodeSessionHistoryCursor,
  sessionHistoryPageInputSchema,
  type SessionMessagesPage,
} from './control-plane/session/history.js';

/** The one path the runtime history route serves. */
export const RUNTIME_HISTORY_PAGE_PATH = '/page';

const MAX_BODY_BYTES = 16 * 1024;
const runtimeHistoryPageInputSchema = sessionHistoryPageInputSchema
  .omit({ expectedRootKiloSessionId: true, kiloSessionId: true })
  .extend({ rootNativeId: sessionIdSchema.optional() })
  .strict();

type RuntimeHistorySession = ReturnType<typeof getSandboxSessionStub>;
type RuntimeHistoryCredential = Awaited<
  ReturnType<RuntimeHistorySession['resolveRuntimeCredentialProxyGrant']>
>;

/**
 * Reads one page of a native session's history for a live runtime credential.
 *
 * The cloud session id and owner come from the verified handle claims and the
 * live persisted grant the Session DO owns; the request body carries no cloud
 * session selector. The target root native id defaults to the handle's own root
 * and, for a shared worktree scope, is authorized by the grant's current
 * `scopeView.memberRootKiloSessionIds` (the authoritative active membership,
 * including the handle root only when it is still such a member). A peer root is
 * mapped to its cloud session server-side and checked against the handle owner;
 * a client-supplied cloud session id is never trusted.
 */
export async function handleRuntimeHistory(
  c: Context<HonoContext>,
  handle: string,
  claims: RuntimeProxyHandleClaims,
  path: string
): Promise<Response> {
  if (!isControlSession(claims.sessionId)) return c.text('Unauthorized', 401);
  if (c.req.method !== 'POST' || path !== RUNTIME_HISTORY_PAGE_PATH)
    return c.text('Not found', 404);
  const body = await readJsonBody(c.req.raw);
  if (body === null) return c.text('Invalid request', 400);
  const parsed = runtimeHistoryPageInputSchema.safeParse(body);
  if (!parsed.success) return c.text('Invalid request', 400);
  const input = parsed.data;

  // The live grant is the authorization owner: a foreign identity, a revoked or
  // expired authorization, or a superseded allocation fence must fail closed
  // before any history is read.
  let credential: RuntimeHistoryCredential;
  try {
    credential = await withDORetry(
      () => getSandboxSessionStub(c.env, claims.userId, claims.sessionId),
      session => session.resolveRuntimeCredentialProxyGrant(handle),
      'resolveRuntimeCredentialProxyGrant'
    );
  } catch {
    return c.text('Credential unavailable', 503);
  }
  if (!credential) return c.text('Unauthorized', 401);

  // Current active membership is authoritative: a shared handle may read only a
  // member root (the handle root included only while it is still one). An
  // unshared handle may read only its own root.
  const requestedRoot = input.rootNativeId ?? claims.kiloSessionId;
  const authorizedRoots = new Set(
    credential.scopeView?.memberRootKiloSessionIds ?? [claims.kiloSessionId]
  );
  if (!authorizedRoots.has(requestedRoot)) return c.text('Not found', 404);

  let cloudSessionId: string = claims.sessionId;
  if (requestedRoot !== claims.kiloSessionId) {
    let resolved: { cloudAgentSessionId: string } | null;
    try {
      resolved = await c.env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession({
        kiloUserId: claims.userId,
        kiloSessionId: requestedRoot,
      });
    } catch {
      return c.text('Credential unavailable', 503);
    }
    if (!resolved) return c.text('Not found', 404);
    cloudSessionId = resolved.cloudAgentSessionId;
  }

  if (input.cursor !== undefined) {
    let cursor: ReturnType<typeof decodeSessionHistoryCursor>;
    try {
      cursor = decodeSessionHistoryCursor(input.cursor);
    } catch {
      return c.text('Invalid request', 400);
    }
    if (
      cursor.sessionId !== cloudSessionId ||
      cursor.rootKiloSessionId !== requestedRoot ||
      cursor.kiloSessionId !== requestedRoot
    ) {
      return c.text('Invalid request', 400);
    }
  }

  let page: SessionMessagesPage | null;
  try {
    page = await withDORetry(
      () => getSandboxSessionStub(c.env, claims.userId, cloudSessionId),
      session =>
        session.getSessionMessagesPage({
          cursor: input.cursor,
          limit: input.limit,
          expectedRootKiloSessionId: requestedRoot,
        }),
      'getSessionMessagesPage'
    );
  } catch {
    return c.text('Session history is temporarily unavailable', 503);
  }
  if (page === null) return c.text('Not found', 404);
  return c.json(page, 200, { 'Cache-Control': 'no-store' });
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  ) {
    return null;
  }
  const text = await readBoundedBody(request, MAX_BODY_BYTES);
  if (text === null || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
