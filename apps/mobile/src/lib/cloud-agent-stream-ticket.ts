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

/** Per-request knobs; `signal` lets a bounded caller cancel the POST. */
export type FetchStreamTicketOptions = { signal?: AbortSignal };

/**
 * The `error` field of a refused response, when its body happens to be the
 * documented object.
 *
 * The status is what a caller classifies on, so the body never decides whether
 * the status reaches it: a proxy's HTML page, an empty body, or any other
 * non-object JSON only costs the specific message, never the status.
 */
async function readRefusalMessage(response: Response): Promise<string | undefined> {
  try {
    const parsed = StreamTicketResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST the cloud-agent stream ticket. The single source of truth for the
 * route, headers, body, and response contract, shared by the session manager
 * (`getTicket`) and the review spectator stream.
 */
export async function fetchCloudAgentStreamTicket(
  sessionId: string,
  organizationId?: string,
  options?: FetchStreamTicketOptions
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
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new StreamTicketHttpError(
      response.status,
      (await readRefusalMessage(response)) ?? 'Failed to get stream ticket'
    );
  }
  const data = StreamTicketResponseSchema.parse(await response.json());
  if (!data.ticket) {
    throw new Error('Missing ticket in stream-ticket response');
  }
  if (data.expiresAt === undefined) {
    throw new Error('Missing expiresAt in stream-ticket response');
  }
  return { ticket: data.ticket, expiresAt: data.expiresAt };
}
