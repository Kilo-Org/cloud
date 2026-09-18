import { z } from 'zod';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';

/**
 * Wire contract for the cloud-agent stream-ticket endpoint. `expiresAt` is the
 * Unix-epoch number `signStreamTicket` returns. All fields are optional here;
 * the required-field check in `fetchCloudAgentStreamTicket` rejects an
 * otherwise-valid object missing `ticket` or `expiresAt`.
 */
export const StreamTicketResponseSchema = z.object({
  ticket: z.string().optional(),
  expiresAt: z.number().optional(),
  error: z.string().optional(),
});

/**
 * The stream-ticket route refused the request with an HTTP status.
 *
 * The status is the difference a caller that only retries cannot otherwise see:
 * a client error names a session this caller may never stream (terminal — the
 * glanceable Approve drops its ask), while 5xx and transport failures are worth
 * another attempt. A bare `Failed to get stream ticket` collapses both.
 */
export class StreamTicketHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'StreamTicketHttpError';
    this.status = status;
  }
}

/**
 * POST the cloud-agent stream ticket. The single source of truth for the
 * route, headers, body, and response contract, shared by the session manager
 * (`getTicket`) and the review spectator stream.
 */
export async function fetchCloudAgentStreamTicket(
  sessionId: string,
  organizationId?: string
): Promise<{ ticket: string; expiresAt: number }> {
  const token = await getAuthTokenForRequest();
  const body = {
    cloudAgentSessionId: sessionId,
    ...(organizationId ? { organizationId } : {}),
  };
  const response = await fetch(`${API_BASE_URL}/api/cloud-agent-next/sessions/stream-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = StreamTicketResponseSchema.parse(await response.json());
  if (!response.ok) {
    throw new StreamTicketHttpError(response.status, data.error ?? 'Failed to get stream ticket');
  }
  if (!data.ticket) {
    throw new Error('Missing ticket in stream-ticket response');
  }
  if (data.expiresAt === undefined) {
    throw new Error('Missing expiresAt in stream-ticket response');
  }
  return { ticket: data.ticket, expiresAt: data.expiresAt };
}
