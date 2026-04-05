import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

export type StreamTicketPayload = {
  userId: string;
  kiloSessionId?: string;
  cloudAgentSessionId: string;
  organizationId?: string;
};

export function signStreamTicket(
  payload: StreamTicketPayload,
  expiresInSeconds = 60
): { ticket: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  const ticket = jwt.sign(
    {
      type: 'stream_ticket',
      ...payload,
      nonce: crypto.randomUUID(),
    },
    NEXTAUTH_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
    }
  );

  return { ticket, expiresAt };
}
