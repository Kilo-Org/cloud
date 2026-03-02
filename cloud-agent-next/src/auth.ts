import jwt from 'jsonwebtoken';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';

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
