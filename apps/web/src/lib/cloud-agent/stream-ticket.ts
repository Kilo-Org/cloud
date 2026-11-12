import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import type { PreviewTarget } from '@cloud-agent-shared/preview-target';

type StreamTicketCommon = {
  userId: string;
  kiloSessionId?: string;
  organizationId?: string;
  ptyId?: string;
};

export type StreamTicketPayload =
  | (StreamTicketCommon & {
      purpose?: 'stream' | 'terminal';
      cloudAgentSessionId: string;
    })
  | (StreamTicketCommon & {
      purpose: 'preview';
      port: number;
    } & PreviewTarget);

type WorktreePreviewTarget = Extract<PreviewTarget, { worktreeId: string }>;

function isWorktreePreviewTarget(target: PreviewTarget): target is WorktreePreviewTarget {
  return target.worktreeId !== undefined;
}

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
  // `jsonwebtoken` derives `exp` from a payload `iat`; one clock reading keeps
  // the returned `expiresAt` equal to the token `exp` across a second boundary.
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + expiresInSeconds;

  const ticket = jwt.sign(
    {
      type: 'stream_ticket',
      ...payload,
      iat: issuedAt,
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
export function signPreviewTicket(
  params: {
    userId: string;
    port: number;
    organizationId?: string;
  } & PreviewTarget
): { ticket: string; expiresAt: number } {
  const target = isWorktreePreviewTarget(params)
    ? { worktreeId: params.worktreeId }
    : { cloudAgentSessionId: params.cloudAgentSessionId };

  return signStreamTicket(
    {
      purpose: 'preview',
      userId: params.userId,
      ...target,
      port: params.port,
      ...(params.organizationId !== undefined ? { organizationId: params.organizationId } : {}),
    },
    PREVIEW_TICKET_TTL_SECONDS
  );
}
