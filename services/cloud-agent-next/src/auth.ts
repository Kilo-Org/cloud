import jwt from 'jsonwebtoken';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';

type StreamTicketPayload = {
  type: 'stream_ticket';
  purpose?: 'stream' | 'terminal' | 'preview';
  userId?: string;
  kiloSessionId?: string;
  cloudAgentSessionId?: string;
  sessionId?: string;
  organizationId?: string;
  ptyId?: string;
  port?: number;
  nonce?: string;
  aud?: string;
};

export const STREAM_TICKET_AUDIENCE = 'cloud-agent-stream';
export const TERMINAL_TICKET_AUDIENCE = 'cloud-agent-terminal';
export const PREVIEW_TICKET_AUDIENCE = 'cloud-agent-preview';
export const PREVIEW_SESSION_AUDIENCE = 'cloud-agent-preview-session';

/** The claims both preview tokens carry: the entry ticket and the session cookie. */
export type PreviewClaims = {
  userId: string;
  cloudAgentSessionId: string;
  port: number;
  organizationId?: string;
};

export type WrapperDispatchTicketClaims = {
  type: 'wrapper_dispatch_ticket';
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

/**
 * A pre-migration raw Kilo user JWT presented as a workerAuthToken. Accepted
 * only so wrapper processes already bound before wrapper dispatch tickets
 * shipped can keep talking to the Worker until their next session/ready
 * dispatch mints a real ticket. Carries no fence claims — callers must treat
 * it as exempt from ticketClaimsMismatchRequestFence.
 */
export type LegacyKiloTokenClaims = {
  type: 'legacy_kilo_token';
  userId: string;
};

export type WrapperAuthClaims = WrapperDispatchTicketClaims | LegacyKiloTokenClaims;

const WRAPPER_DISPATCH_TICKET_MAX_LIFETIME_SECONDS = 4 * 60 * 60;

export type SecretBinding = string | { get(): Promise<string> };

export async function resolveSecret(
  secret: SecretBinding | null | undefined
): Promise<string | null> {
  if (!secret) {
    return null;
  }
  if (typeof secret === 'string') {
    return secret;
  }

  try {
    return await secret.get();
  } catch {
    return null;
  }
}

export function validateStreamTicket(
  ticket: string | null,
  secret: string | null | undefined,
  expectedAudience: string
): { success: true; payload: StreamTicketPayload } | { success: false; error: string } {
  if (!ticket) {
    return { success: false, error: 'Missing stream ticket' };
  }
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }

  try {
    const payload = jwt.verify(ticket, secret, {
      algorithms: ['HS256'],
    }) as StreamTicketPayload;

    if (payload.type !== 'stream_ticket') {
      return { success: false, error: 'Invalid ticket type' };
    }

    if (payload.aud !== expectedAudience) {
      return { success: false, error: 'Invalid ticket audience' };
    }

    return { success: true, payload };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Ticket expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid ticket signature' };
    }
    return { success: false, error: 'Ticket validation failed' };
  }
}

export function mintWrapperDispatchTicket(
  claims: WrapperDispatchTicketClaims,
  secret: string
): string {
  return jwt.sign(claims, secret, {
    algorithm: 'HS256',
    expiresIn: WRAPPER_DISPATCH_TICKET_MAX_LIFETIME_SECONDS,
  });
}

export const PREVIEW_SESSION_LIFETIME_SECONDS = 3600;

export function mintPreviewSessionToken(
  claims: PreviewClaims,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  return jwt.sign(
    { ...claims, type: 'preview_session', exp: nowSeconds + PREVIEW_SESSION_LIFETIME_SECONDS },
    secret,
    { algorithm: 'HS256', noTimestamp: true, audience: PREVIEW_SESSION_AUDIENCE }
  );
}

export type PreviewTokenValidation =
  | { success: true; claims: PreviewClaims }
  | { success: false; error: string };

const INVALID_PREVIEW_CLAIMS = { success: false, error: 'Invalid preview claims' } as const;

function previewClaimsFrom(payload: Record<string, unknown>): PreviewTokenValidation {
  const { userId, cloudAgentSessionId, port, exp, organizationId } = payload;
  if (typeof userId !== 'string' || userId.length === 0) return INVALID_PREVIEW_CLAIMS;
  if (typeof cloudAgentSessionId !== 'string' || cloudAgentSessionId.length === 0) {
    return INVALID_PREVIEW_CLAIMS;
  }
  if (typeof port !== 'number' || !Number.isInteger(port)) return INVALID_PREVIEW_CLAIMS;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return INVALID_PREVIEW_CLAIMS;
  return {
    success: true,
    claims: {
      userId,
      cloudAgentSessionId,
      port,
      ...(typeof organizationId === 'string' ? { organizationId } : {}),
    },
  };
}

/** The 60-second entry ticket the web app mints (a `stream_ticket` with purpose `preview`). */
export function validatePreviewEntryTicket(
  ticket: string | null,
  secret: string | null | undefined
): PreviewTokenValidation {
  const validated = validateStreamTicket(ticket, secret, PREVIEW_TICKET_AUDIENCE);
  if (!validated.success) return validated;
  if (validated.payload.purpose !== 'preview') {
    return { success: false, error: 'Invalid ticket purpose' };
  }
  return previewClaimsFrom(validated.payload as unknown as Record<string, unknown>);
}

/** The host-bound session token the Worker sets as the preview cookie. */
export function validatePreviewSessionToken(
  token: string | null,
  secret: string | null | undefined
): PreviewTokenValidation {
  if (!token) return { success: false, error: 'Missing preview session' };
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Preview session expired' };
    }
    return { success: false, error: 'Invalid preview session' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { success: false, error: 'Invalid preview session' };
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== 'preview_session') {
    return { success: false, error: 'Invalid preview session type' };
  }
  if (record.aud !== PREVIEW_SESSION_AUDIENCE) {
    return { success: false, error: 'Invalid preview session audience' };
  }
  return previewClaimsFrom(record);
}

function isWrapperDispatchTicketClaims(payload: unknown): payload is WrapperDispatchTicketClaims {
  if (typeof payload !== 'object' || payload === null) return false;
  const claims = payload as Record<string, unknown>;
  return (
    claims.type === 'wrapper_dispatch_ticket' &&
    typeof claims.userId === 'string' &&
    typeof claims.cloudAgentSessionId === 'string' &&
    typeof claims.kiloSessionId === 'string' &&
    typeof claims.wrapperRunId === 'string' &&
    typeof claims.wrapperGeneration === 'number' &&
    typeof claims.wrapperConnectionId === 'string'
  );
}

/**
 * Grandfather only audience-less Kilo tokens for pre-migration wrappers.
 * Resource-audience tokens, including cloud-agent-next, are not wrapper capabilities
 * and must not inherit this legacy path's exemption from dispatch fence checks.
 */
async function legacyKiloTokenClaims(
  ticket: string,
  secret: string
): Promise<LegacyKiloTokenClaims | undefined> {
  try {
    const payload = await verifyKiloToken(ticket, secret);
    return { type: 'legacy_kilo_token', userId: payload.kiloUserId };
  } catch {
    return undefined;
  }
}

export async function validateWrapperDispatchTicket(
  authHeader: string | null,
  secret: string | null | undefined
): Promise<{ success: true; claims: WrapperAuthClaims } | { success: false; error: string }> {
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }

  const ticket = extractBearerToken(authHeader);
  if (!ticket) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(ticket, secret, { algorithms: ['HS256'] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Ticket expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid ticket signature' };
    }
    return { success: false, error: 'Ticket validation failed' };
  }

  if (!isWrapperDispatchTicketClaims(payload)) {
    const legacyClaims = await legacyKiloTokenClaims(ticket, secret);
    if (legacyClaims) {
      return { success: true, claims: legacyClaims };
    }
    return { success: false, error: 'Invalid ticket type' };
  }

  return {
    success: true,
    claims: {
      type: payload.type,
      userId: payload.userId,
      cloudAgentSessionId: payload.cloudAgentSessionId,
      kiloSessionId: payload.kiloSessionId,
      wrapperRunId: payload.wrapperRunId,
      wrapperGeneration: payload.wrapperGeneration,
      wrapperConnectionId: payload.wrapperConnectionId,
    },
  };
}
