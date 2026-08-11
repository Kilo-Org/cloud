import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { captureException } from '@sentry/nextjs';
import {
  clientIpFromHeaders,
  emitSupportServiceAccessEvent,
  routeFromHeaders,
  userTarget,
  type SupportServiceOutcome,
} from '@/lib/admin/admin-access-log';
import { findUserById, SoftDeletePreconditionError } from '@/lib/user';
import { performGdprRemoval } from '@/lib/user/gdpr-removal';
import {
  ActorEmailSchema,
  authorizeSupportRequest,
  isSupportDeletionRefused,
  RequestIdSchema,
} from '../../_auth';

const BodySchema = z.object({
  userId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  actorEmail: ActorEmailSchema,
  requestId: RequestIdSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeSupportRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { userId, email, actorEmail, requestId } = parsed.data;

  const emit = (outcome: SupportServiceOutcome, targetUserId?: string): void => {
    emitSupportServiceAccessEvent({
      method: 'POST',
      route: routeFromHeaders(request.headers),
      ip: clientIpFromHeaders(request.headers),
      claimedActorEmail: actorEmail,
      correlationId: requestId,
      outcome,
      target: targetUserId ? userTarget(targetUserId) : null,
      targetEmailHash: null,
    });
  };

  try {
    const user = await findUserById(userId);
    if (!user) {
      emit('not_found');
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (isSoftDeletedBlockedReason(user.blocked_reason)) {
      emit('already_deleted', user.id);
      return NextResponse.json({
        success: true,
        message: `Account for user ${userId} is already soft-deleted`,
      });
    }

    if (user.google_user_email.toLowerCase() !== email) {
      emit('conflict', user.id);
      return NextResponse.json({ error: 'Email does not match user' }, { status: 409 });
    }

    if (isSupportDeletionRefused(user)) {
      emit('refused', user.id);
      return NextResponse.json(
        { error: 'Support API cannot delete this account' },
        { status: 403 }
      );
    }

    const { warnings } = await performGdprRemoval(userId, {
      destroyReason: 'admin_request',
      actor: { id: 'support-automation', email: actorEmail },
    });

    emit('deleted', user.id);
    return NextResponse.json({
      success: true,
      message: `Account for user ${userId} has been soft-deleted and PII removed`,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    if (error instanceof SoftDeletePreconditionError) {
      emit('precondition', userId);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    captureException(error, {
      tags: { source: 'support-gdpr-removal' },
      extra: { userId },
    });
    emit('error', userId);
    return NextResponse.json(
      { error: 'Database deletion failed — check Sentry for details' },
      { status: 500 }
    );
  }
}
