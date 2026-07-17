import jwt from 'jsonwebtoken';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';

type StreamTicketPayload = {
  type: 'stream_ticket';
  purpose?: 'stream' | 'terminal';
  userId?: string;
  kiloSessionId?: string;
  cloudAgentSessionId?: string;
  sessionId?: string;
  organizationId?: string;
  ptyId?: string;
  nonce?: string;
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

export async function validateKiloToken(
  authHeader: string | null,
  secret: string | null | undefined
): Promise<
  | { success: true; userId: string; token: string; botId?: string }
  | { success: false; error: string }
> {
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }

  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  try {
    const payload = await verifyKiloToken(token, secret);
    return { success: true, userId: payload.kiloUserId, token, botId: payload.botId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JWT verification failed';
    return { success: false, error: message };
  }
}

export function validateStreamTicket(
  ticket: string | null,
  secret: string | null | undefined
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
 * Re-verifies the token through the canonical verifyKiloToken so the legacy
 * path enforces the same version/audience/shape guards as validateKiloToken —
 * in particular, audience-scoped tokens (e.g. internal service tokens) must
 * not be accepted as wrapper auth.
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
