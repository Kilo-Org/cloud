import type { Context } from 'hono';
import { validateCfAccessRequest, type AccessPayload } from '@kilocode/worker-utils/cf-access';
import type { WastelandEnv } from '../wasteland.worker';
import type { DebugOperator } from './auth.middleware';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { logger } from '../util/log.util';

/**
 * The debug surface is opt-in per deployment: only an explicit
 * `WASTELAND_DEBUG_ROUTES=enabled` serves `/debug/*`. Deployments that do
 * not set it answer 404 for the whole tree, independently of
 * `ENVIRONMENT`.
 */
export function debugRoutesEnabled(env: { WASTELAND_DEBUG_ROUTES?: string }): boolean {
  return env.WASTELAND_DEBUG_ROUTES === 'enabled';
}

/**
 * Parse the comma-separated operator allowlist. Entries are Cloudflare
 * Access user emails or service-token common names, compared
 * case-insensitively. An absent or empty list admits no operator.
 */
export function parseDebugOperatorAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(entry => entry.length > 0)
  );
}

export function debugOperatorFromAccessPayload(payload: AccessPayload): DebugOperator {
  if ('email' in payload) return { kind: 'user', id: payload.email.toLowerCase() };
  return { kind: 'service-token', id: payload.common_name.toLowerCase() };
}

export function describeDebugOperator(operator: DebugOperator): string {
  return `${operator.kind}:${operator.id}`;
}

const LOCAL_DEVELOPMENT_OPERATOR: DebugOperator = {
  kind: 'local-development',
  id: 'local-development',
};

export function getDebugOperator(c: Context<WastelandEnv>): DebugOperator {
  return c.get('debugOperator') ?? LOCAL_DEVELOPMENT_OPERATOR;
}

/**
 * Gate for the whole `/debug/*` tree.
 *
 * - The tree is absent unless the deployment sets
 *   `WASTELAND_DEBUG_ROUTES=enabled`.
 * - Local development keeps the documented bypass.
 * - Any deployed environment requires a verified Cloudflare Access
 *   assertion whose user email or service-token common name is listed in
 *   `WASTELAND_DEBUG_OPERATORS`.
 *
 * Every admitted request is audited with the operator identity, method and
 * path.
 */
export async function debugAccessMiddleware(
  c: Context<WastelandEnv>,
  next: () => Promise<void>
): Promise<Response | void> {
  if (!debugRoutesEnabled(c.env)) {
    return c.notFound();
  }

  const method = c.req.method;
  const path = c.req.path;

  if (c.env.ENVIRONMENT === 'development') {
    c.set('debugOperator', LOCAL_DEVELOPMENT_OPERATOR);
    logger.info('debug.access', {
      operator: describeDebugOperator(LOCAL_DEVELOPMENT_OPERATOR),
      method,
      path,
    });
    return next();
  }

  let payload: AccessPayload;
  try {
    payload = await validateCfAccessRequest(c.req.raw, {
      team: c.env.CF_ACCESS_TEAM,
      audience: c.env.CF_ACCESS_AUD,
    });
  } catch (e) {
    logger.warn('debug.access unauthorized', {
      method,
      path,
      error: e instanceof Error ? e.message : 'unknown',
    });
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const operator = debugOperatorFromAccessPayload(payload);
  const allowlist = parseDebugOperatorAllowlist(c.env.WASTELAND_DEBUG_OPERATORS);
  if (!allowlist.has(operator.id)) {
    logger.warn('debug.access forbidden', {
      method,
      path,
      operator: describeDebugOperator(operator),
    });
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  c.set('debugOperator', operator);
  logger.info('debug.access', {
    operator: describeDebugOperator(operator),
    method,
    path,
  });
  return next();
}

export type DebugUserAction = {
  wastelandId: string;
  userId: string;
  operation: string;
};

/**
 * Authorize a debug route that acts for a user before it reads that
 * user's stored credential or calls a provider.
 *
 * The named user must belong to the named wasteland (owner or member).
 * Returns the rejection response, or null when the action is authorized.
 * Every authorized action is audited with the operator, wasteland, target
 * user and provider operation.
 */
export async function authorizeDebugUserAction(
  c: Context<WastelandEnv>,
  action: DebugUserAction
): Promise<Response | null> {
  const { wastelandId, userId, operation } = action;
  const operator = getDebugOperator(c);
  const doStub = getWastelandDOStub(c.env, wastelandId);
  const config = await doStub.getConfig();
  if (!config) {
    return c.json({ error: 'Wasteland not found' }, 404);
  }

  const isOwner = config.owner_user_id === userId;
  const isMember = isOwner || (await doStub.listMembers()).some(m => m.user_id === userId);
  if (!isMember) {
    logger.warn('debug.action forbidden', {
      operator: describeDebugOperator(operator),
      wastelandId,
      userId,
      operation,
    });
    return c.json({ error: 'User does not belong to this wasteland' }, 403);
  }

  logger.info('debug.action', {
    operator: describeDebugOperator(operator),
    wastelandId,
    userId,
    operation,
  });
  return null;
}
