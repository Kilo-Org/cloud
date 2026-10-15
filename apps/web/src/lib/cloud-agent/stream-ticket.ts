import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

export type StreamTicketPayload = {
  purpose?: 'stream' | 'terminal' | 'preview';
  userId: string;
  kiloSessionId?: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  ptyId?: string;
  port?: number;
};

function audienceForPurpose(purpose: StreamTicketPayload['purpose']): string {
  switch (purpose ?? 'stream') {
    case 'stream':
      return 'cloud-agent-stream';
    case 'terminal':
      return 'cloud-agent-terminal';
    case 'preview':
      return 'cloud-agent-preview';
  }
}

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
      audience: audienceForPurpose(payload.purpose),
    }
  );

  return { ticket, expiresAt };
}

const PREVIEW_TICKET_TTL_SECONDS = 60;

/**
 * Mints the short-lived entry ticket for the preview host. The preview TTL and
 * audience are owned here so both routers mint identically; the caller builds
 * the entry URL from the returned ticket. The Worker consumes its nonce at the
 * preview host entry, so each ticket opens one preview session.
 */
export function signPreviewTicket(params: {
  userId: string;
  cloudAgentSessionId: string;
  port: number;
  organizationId?: string;
}): { ticket: string; expiresAt: number } {
  return signStreamTicket(
    {
      purpose: 'preview',
      userId: params.userId,
      cloudAgentSessionId: params.cloudAgentSessionId,
      port: params.port,
      ...(params.organizationId !== undefined ? { organizationId: params.organizationId } : {}),
    },
    PREVIEW_TICKET_TTL_SECONDS
  );
}
