import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';
import type { Env } from './types.js';

type StreamTicketPayload = {
  type: 'stream_ticket';
  userId?: string;
  kiloSessionId?: string;
  cloudAgentSessionId?: string;
  sessionId?: string;
  organizationId?: string;
  nonce?: string;
};

export async function validateKiloToken(
  authHeader: string | null,
  secret: string
): Promise<
  | { success: true; userId: string; token: string; botId?: string }
  | { success: false; error: string }
> {
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
  secret: string
): { success: true; payload: StreamTicketPayload } | { success: false; error: string } {
  if (!ticket) {
    return { success: false, error: 'Missing stream ticket' };
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

/**
 * Validates JWT token and extracts user ID for tRPC context
 * @throws {TRPCError} If authentication fails
 */
export async function authenticate(
  request: Request,
  env: Env
): Promise<{ userId: string; token: string; botId?: string }> {
  const authHeader = request.headers.get('authorization');

  const result = await validateKiloToken(authHeader, env.NEXTAUTH_SECRET);

  if (!result.success) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: result.error,
    });
  }

  return { userId: result.userId, token: result.token, botId: result.botId };
}
