import jwt from 'jsonwebtoken';
import type { TokenPayload } from './types.js';

type StreamTicketPayload = {
  type: 'stream_ticket';
  userId?: string;
  kiloSessionId?: string;
  cloudAgentSessionId?: string;
  sessionId?: string;
  organizationId?: string;
  nonce?: string;
};

export function validateKiloToken(
  authHeader: string | null,
  secret: string
):
  | { success: true; userId: string; token: string; botId?: string }
  | { success: false; error: string } {
  // Check header exists and has Bearer format
  if (!authHeader) {
    return { success: false, error: 'Missing Authorization header' };
  }

  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { success: false, error: 'Invalid Authorization header format' };
  }

  const token = authHeader.substring(7).trim();

  try {
    // Verify JWT signature and decode
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
    }) as TokenPayload;

    // Validate token version
    if (payload.version !== 3) {
      return {
        success: false,
        error: `Invalid token version: ${payload.version}, expected 3`,
      };
    }

    // Token is valid
    return {
      success: true,
      userId: payload.kiloUserId,
      token,
      botId: payload.botId,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid token signature' };
    }
    return { success: false, error: 'Token validation failed' };
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
