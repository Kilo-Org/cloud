import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  verifyUserOwnsSessionByCloudAgentId,
  verifyOrgOwnsSessionByCloudAgentId,
} from '@/lib/cloud-agent/session-ownership';
import { signStreamTicket } from '@/lib/cloud-agent/stream-ticket';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import * as z from 'zod';
import { ORGANIZATION_ROLES } from '@kilocode/app-shared/organizations';
import {
  addAdminAuditMetadata,
  adminActionContextFromHeaders,
  runElevatedOrganizationWrite,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';

const streamTicketSchema = z.object({
  cloudAgentSessionId: z.string().min(1),
  organizationId: z.string().uuid().optional(),
});

function handleTRPCError(error: unknown): NextResponse {
  if (error instanceof TRPCError) {
    // Map TRPC error codes to HTTP status codes
    const statusCode = error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status: statusCode });
  }

  captureException(error, {
    tags: { source: 'cloud-agent-stream-ticket' },
  });
  return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 });
}

/**
 * Get a stream ticket for WebSocket authentication.
 *
 * Creates a short-lived JWT ticket that can be used to authenticate
 * a WebSocket connection to the cloud-agent stream endpoint.
 *
 * Supports both authentication methods:
 * - Session cookie (for web frontend)
 * - Authorization Bearer token (for API/extension users)
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
    const { user, tokenSource, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

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

    if (!organizationId) {
      const sessionOwnership = await verifyUserOwnsSessionByCloudAgentId(
        db,
        user.id,
        cloudAgentSessionId
      );
      if (!sessionOwnership) {
        return NextResponse.json({ error: 'Session not found or access denied' }, { status: 403 });
      }
      return NextResponse.json(
        signStreamTicket({
          userId: user.id,
          kiloSessionId: sessionOwnership.kiloSessionId,
          cloudAgentSessionId,
        })
      );
    }

    await ensureOrganizationAccess({ user, tokenSource }, organizationId);
    return await runElevatedOrganizationWrite(
      adminActionContextFromHeaders(user, request.headers),
      {
        organizationId,
        requiredRoles: ORGANIZATION_ROLES,
        action: 'organization.cloud_agent_session.stream_ticket',
        message: 'Signed a cloud agent stream ticket',
      },
      async () => {
        const sessionOwnership = await verifyOrgOwnsSessionByCloudAgentId(
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
        // Only a session the organization owns is named: the requested id is
        // caller-supplied text until this check matched it to a stored session.
        addAdminAuditMetadata({ kiloSessionId: sessionOwnership.kiloSessionId });
        return NextResponse.json(
          signStreamTicket({
            userId: user.id,
            kiloSessionId: sessionOwnership.kiloSessionId,
            cloudAgentSessionId,
            organizationId,
          })
        );
      }
    );
  } catch (error) {
    return handleTRPCError(error);
  }
}
