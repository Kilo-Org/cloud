import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import {
  cloudAgentSyncHostedClaims,
  type CloudAgentSyncLiveAuthorization,
} from '@kilocode/worker-utils/cloud-agent-session-sync';

import { AUTH_CLOCK_SKEW_SECONDS, syncSigningKey, verifyGrant, type Principal } from '../auth';
import type { Env } from '../env';
import { principalSchema, sessionIDSchema, tenantSchema, userIDSchema } from '../protocol';

export type LiveRole = 'runner' | 'viewer' | 'controller';
type LiveAudience = 'session-relay' | 'session-presence' | 'session-notifications';

const MAX_TICKET_SECONDS = 120;
const numericDate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const storedTicketSchema = z
  .strictObject({
    version: z.literal(1),
    aud: z.enum(['session-relay', 'session-presence', 'session-notifications']),
    env: z.string().min(1),
    tenant: tenantSchema,
    sessionID: sessionIDSchema.optional(),
    userID: userIDSchema,
    role: z.enum(['runner', 'viewer', 'controller']),
    workload: cloudAgentSyncHostedClaims.workload.optional(),
    host: cloudAgentSyncHostedClaims.host.optional(),
    native: cloudAgentSyncHostedClaims.native.optional(),
    liveIdentity: cloudAgentSyncHostedClaims.liveIdentity.optional(),
    exp: numericDate,
    iat: numericDate,
  })
  .refine(ticket =>
    ticket.workload === undefined
      ? ticket.host === undefined &&
        ticket.native === undefined &&
        ticket.liveIdentity === undefined
      : ticket.role === 'runner' &&
        ticket.aud !== 'session-notifications' &&
        ticket.host !== undefined &&
        ticket.native !== undefined &&
        ticket.liveIdentity !== undefined &&
        (ticket.aud !== 'session-relay' || ticket.native.sessionID === ticket.sessionID)
  );

export const ticketSchema = storedTicketSchema
  .refine(ticket => ticket.exp > ticket.iat && ticket.exp - ticket.iat <= MAX_TICKET_SECONDS)
  .refine(
    ticket => principalSchema.safeParse({ userID: ticket.userID, tenant: ticket.tenant }).success
  )
  .refine(ticket =>
    ticket.aud === 'session-relay' ? ticket.sessionID !== undefined : ticket.sessionID === undefined
  )
  .refine(ticket => ticket.aud !== 'session-notifications' || ticket.role === 'viewer');

export type LiveTicket = z.infer<typeof ticketSchema>;

export class LiveTicketError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'LiveTicketError';
  }
}

export async function mintHostedTicket(
  env: Env,
  authorization: CloudAgentSyncLiveAuthorization,
  audience: 'session-relay' | 'session-presence',
  sessionID?: string
): Promise<{ ticket: string; expiresAt: string }> {
  if (!env.ENVIRONMENT)
    throw new LiveTicketError(503, 'auth_unavailable', 'Authentication is temporarily unavailable');
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + MAX_TICKET_SECONDS, Math.floor(authorization.expiresAt / 1000));
  const claims = ticketSchema.safeParse({
    version: 1,
    aud: audience,
    env: env.ENVIRONMENT,
    userID: authorization.userID,
    tenant: authorization.organizationID
      ? { type: 'organization', id: authorization.organizationID }
      : { type: 'user', id: authorization.userID },
    role: 'runner',
    workload: authorization.workload,
    host: authorization.host,
    native: authorization.native,
    liveIdentity: authorization.liveIdentity,
    ...(sessionID === undefined ? {} : { sessionID }),
    iat: now,
    exp,
  });
  if (!claims.success)
    throw new LiveTicketError(403, 'access_denied', 'Hosted live authority is invalid or expired');
  const ticket = await new SignJWT(claims.data)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(await syncSigningKey(env));
  return { ticket, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Exchanges the same, freshly verified grant that authorized the route. ACL checks precede this. */
export async function mintTicket(
  request: Request,
  env: Env,
  principal: Principal,
  audience: LiveAudience,
  role: LiveRole,
  sessionID?: string
): Promise<{ ticket: string; expiresAt: string }> {
  const token = extractBearerToken(request.headers.get('Authorization'));
  if (!token) throw new LiveTicketError(401, 'unauthenticated', 'A sync grant is required');
  if (!env.ENVIRONMENT) {
    throw new LiveTicketError(503, 'auth_unavailable', 'Authentication is temporarily unavailable');
  }
  const grant = await verifyGrant(token, env).catch(() => {
    throw new LiveTicketError(503, 'auth_unavailable', 'Authentication is temporarily unavailable');
  });
  const bound = principalSchema.safeParse(principal);
  if (
    !grant ||
    !bound.success ||
    grant.principal.userID !== bound.data.userID ||
    grant.principal.tenant.type !== bound.data.tenant.type ||
    grant.principal.tenant.id !== bound.data.tenant.id
  ) {
    throw new LiveTicketError(401, 'invalid_grant', 'The sync grant is invalid or expired');
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + MAX_TICKET_SECONDS, grant.expiresAt);
  if (exp <= now) {
    throw new LiveTicketError(401, 'invalid_grant', 'The sync grant is invalid or expired');
  }
  const claims = ticketSchema.safeParse({
    version: 1,
    aud: audience,
    env: env.ENVIRONMENT,
    tenant: grant.principal.tenant,
    ...(sessionID === undefined ? {} : { sessionID }),
    userID: grant.principal.userID,
    role,
    exp,
    iat: now,
  });
  if (!claims.success) {
    throw new LiveTicketError(400, 'invalid_request', 'The live ticket scope is invalid');
  }
  const ticket = await new SignJWT(claims.data)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(await syncSigningKey(env));
  return { ticket, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Relay and presence accept only short-lived, environment-bound tickets for their audience. */
export async function verifyTicket(
  token: string,
  env: Env,
  audience: LiveAudience
): Promise<LiveTicket | undefined> {
  if (!env.ENVIRONMENT) return undefined;
  const key = await syncSigningKey(env);
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      audience,
      requiredClaims: ['iat', 'exp'],
    }));
  } catch {
    return undefined;
  }
  const parsed = ticketSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.aud !== audience ||
    parsed.data.env !== env.ENVIRONMENT ||
    parsed.data.iat > Math.floor(Date.now() / 1000) + AUTH_CLOCK_SKEW_SECONDS
  ) {
    return undefined;
  }
  return parsed.data;
}
