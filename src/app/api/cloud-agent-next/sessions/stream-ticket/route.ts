import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { db } from '@/lib/drizzle';
import {
  verifyUserOwnsSessionV2ByCloudAgentId,
  verifyOrgOwnsSessionV2ByCloudAgentId,
} from '@/lib/cloud-agent/session-ownership';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import * as z from 'zod';

const streamTicketSchema = z.object({
  cloudAgentSessionId: z.string().min(1),
  organizationId: z.string().uuid().optional(),
});

function handleTRPCError(error: unknown): NextResponse {
  if (error instanceof TRPCError) {
    const statusCode = error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status: statusCode });
  }

  captureException(error, {
    tags: { source: 'cloud-agent-next-stream-ticket' },
  });
  return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 });
}

/**
 * Get a stream ticket for WebSocket authentication (cloud-agent-next).
 *
 * Creates a short-lived JWT ticket that can be used to authenticate
 * a WebSocket connection to the cloud-agent-next stream endpoint.
 *
 * Uses cli_sessions_v2 table for session ownership verification.
 *
 * Supports both personal and organization contexts:
 * - Personal: verifies the user owns the session
 * - Organization: verifies org membership and that the org owns the session
 *
 * The ticket includes:
 * - type: 'stream_ticket' to identify ticket type
 * - userId: The authenticated user's ID
 * - kiloSessionId: The CLI session ID for audit/tracing
 * - cloudAgentSessionId: The cloud-agent session ID for WebSocket routing
 * - organizationId: (optional) The organization context for the session
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

    const { cloudAgentSessionId, organizationId } = validation.data;

    if (organizationId) {
      // Organization context: verify membership then session ownership
      await ensureOrganizationAccess({ user }, organizationId);

      const sessionOwnership = await verifyOrgOwnsSessionV2ByCloudAgentId(
        db,
        organizationId,
        user.id,
        cloudAgentSessionId
      );
      if (!sessionOwnership) {
        return NextResponse.json(
          { error: 'Organization does not own this session' },
          { status: 403 }
        );
      }

      const result = signStreamTicket({
        userId: user.id,
        kiloSessionId: sessionOwnership.kiloSessionId,
        cloudAgentSessionId,
        organizationId,
      });
      return NextResponse.json(result);
    } else {
      // Personal context: verify user owns the session
      const sessionOwnership = await verifyUserOwnsSessionV2ByCloudAgentId(
        db,
        user.id,
        cloudAgentSessionId
      );
      if (!sessionOwnership) {
        return NextResponse.json({ error: 'Session not found or access denied' }, { status: 403 });
      }

      const result = signStreamTicket({
        userId: user.id,
        kiloSessionId: sessionOwnership.kiloSessionId,
        cloudAgentSessionId,
      });
      return NextResponse.json(result);
    }
  } catch (error) {
    return handleTRPCError(error);
  }
}
