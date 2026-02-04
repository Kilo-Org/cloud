import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2 } from '@/db/schema';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';

const streamTicketSchema = z.object({
  cloudAgentSessionId: z.string().min(1),
  organizationId: z.string().uuid().optional(), // Accepted but ignored for now
});

/**
 * Get a stream ticket for WebSocket authentication (cloud-agent-next).
 *
 * Creates a short-lived JWT ticket that can be used to authenticate
 * a WebSocket connection to the cloud-agent-next stream endpoint.
 *
 * Uses cli_sessions_v2 table for session ownership verification.
 *
 * The ticket includes:
 * - type: 'stream_ticket' to identify ticket type
 * - userId: The authenticated user's ID
 * - kiloSessionId: The CLI session ID for audit/tracing
 * - cloudAgentSessionId: The cloud-agent session ID for WebSocket routing
 * - nonce: Random UUID for replay protection
 *
 * Ticket expires in 60 seconds to limit replay window.
 */
export async function POST(request: Request) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

    if (authFailedResponse) {
      return authFailedResponse;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
    }

    const validation = streamTicketSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: validation.error.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        { status: 400 }
      );
    }

    const { cloudAgentSessionId } = validation.data;

    // Verify user owns the session via cli_sessions_v2
    const [session] = await db
      .select({ session_id: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId),
          eq(cli_sessions_v2.kilo_user_id, user.id)
        )
      )
      .limit(1);

    if (!session) {
      return NextResponse.json({ error: 'Session not found or access denied' }, { status: 403 });
    }

    const result = signStreamTicket({
      userId: user.id,
      kiloSessionId: session.session_id,
      cloudAgentSessionId,
    });

    return NextResponse.json(result);
  } catch (error) {
    captureException(error, {
      tags: { source: 'cloud-agent-next-stream-ticket' },
    });
    return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 });
  }
}
