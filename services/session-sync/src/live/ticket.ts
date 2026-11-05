import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { AUTH_CLOCK_SKEW_SECONDS, syncSigningKey, verifyGrant, type Principal } from '../auth';
import type { Env } from '../env';
import { principalSchema, sessionIDSchema, tenantSchema, userIDSchema } from '../protocol';

export type LiveRole = 'runner' | 'viewer' | 'controller';
type LiveAudience = 'session-relay' | 'session-presence';

const MAX_TICKET_SECONDS = 120;
const numericDate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ticketSchema = z
  .strictObject({
    version: z.literal(1),
    aud: z.enum(['session-relay', 'session-presence']),
    env: z.string().min(1),
    tenant: tenantSchema,
    sessionID: sessionIDSchema.optional(),
    userID: userIDSchema,
    role: z.enum(['runner', 'viewer', 'controller']),
    exp: numericDate,
    iat: numericDate,
  })
  .refine(ticket => ticket.exp > ticket.iat && ticket.exp - ticket.iat <= MAX_TICKET_SECONDS)
  .refine(
    ticket => principalSchema.safeParse({ userID: ticket.userID, tenant: ticket.tenant }).success
  )
  .refine(ticket =>
    ticket.aud === 'session-relay' ? ticket.sessionID !== undefined : ticket.sessionID === undefined
  );

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
