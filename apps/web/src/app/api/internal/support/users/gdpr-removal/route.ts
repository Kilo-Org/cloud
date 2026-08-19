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
import { findUserById } from '@/lib/user';
import { getUserDeletionRequestById } from '@/lib/user/deletion';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { DeletionRefusalCode } from '@/lib/user/deletion-queue/deletion-intake';
import {
  ActorEmailSchema,
  authorizeSupportRequest,
  isSupportDeletionRefused,
  parseActorEmail,
  RequestIdSchema,
} from '../../_auth';

const BodySchema = z.object({
  userId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  actorEmail: ActorEmailSchema,
  requestId: RequestIdSchema,
});

export type SupportGdprRemovalPostResponse =
  | { error: string; code?: 'USER_NOT_FOUND' }
  | { status: 'already_deleted' }
  | { requestId: string; status: 'enqueued' | 'already_active' };

export type SupportGdprRemovalGetResponse =
  | { error: string; code?: 'DELETION_REQUEST_NOT_FOUND' }
  | {
      status: string;
      startedAt: string;
      completedAt: string | null;
    };

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
      return NextResponse.json(
        { error: 'User not found', code: 'USER_NOT_FOUND' },
        { status: 404 }
      );
    }

    if (isSoftDeletedBlockedReason(user.blocked_reason)) {
      emit('already_deleted', user.id);
      return NextResponse.json({ status: 'already_deleted' }, { status: 202 });
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

    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: null, email: actorEmail },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });

    if (!result) {
      emit('error', user.id);
      return NextResponse.json({ error: 'User deletion could not be queued' }, { status: 500 });
    }

    if (result.status === 'refused' || result.status === 'invalid') {
      emit('refused', user.id);
      return NextResponse.json({ error: enqueueFailureMessage(result.code) }, { status: 400 });
    }

    emit('enqueued', user.id);
    return NextResponse.json(
      { requestId: result.requestId, status: result.status },
      { status: 202 }
    );
  } catch (error) {
    captureException(error, {
      tags: { source: 'support-gdpr-removal' },
      extra: { userId },
    });
    emit('error', userId);
    return NextResponse.json(
      { error: 'Database deletion queue failed — check Sentry for details' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeSupportRequest(request);
  if (unauthorized) return unauthorized;

  const actorEmail = parseActorEmail(request.headers.get('x-actor-email'));
  if (actorEmail === null) {
    return NextResponse.json({ error: 'Invalid actorEmail' }, { status: 400 });
  }

  const csaRequestIdParsed = RequestIdSchema.safeParse(request.headers.get('x-request-id'));
  if (!csaRequestIdParsed.success) {
    return NextResponse.json({ error: 'Invalid requestId header' }, { status: 400 });
  }
  const csaRequestId = csaRequestIdParsed.data;

  const requestIdParsed = z
    .string()
    .uuid()
    .safeParse(request.nextUrl.searchParams.get('requestId'));
  if (!requestIdParsed.success) {
    return NextResponse.json({ error: 'Invalid requestId' }, { status: 400 });
  }
  const requestId = requestIdParsed.data;

  const emit = (outcome: SupportServiceOutcome): void => {
    emitSupportServiceAccessEvent({
      method: 'GET',
      route: routeFromHeaders(request.headers),
      ip: clientIpFromHeaders(request.headers),
      claimedActorEmail: actorEmail,
      correlationId: csaRequestId,
      outcome,
      target: null,
      targetEmailHash: null,
    });
  };

  try {
    const deletion = await getUserDeletionRequestById(requestId);
    if (!deletion) {
      emit('not_found');
      return NextResponse.json(
        {
          error: 'Deletion request not found',
          code: 'DELETION_REQUEST_NOT_FOUND',
        },
        { status: 404 }
      );
    }

    emit('found');
    return NextResponse.json({
      status: deletion.request.status,
      startedAt: new Date(deletion.request.created_at).toISOString(),
      completedAt: deletion.request.completed_at
        ? new Date(deletion.request.completed_at).toISOString()
        : null,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'support-gdpr-removal-status' },
      extra: { requestId },
    });
    emit('error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function enqueueFailureMessage(code: DeletionRefusalCode): string {
  if (
    code === DeletionRefusalCode.ProtectedAdmin ||
    code === DeletionRefusalCode.ProtectedBot ||
    code === DeletionRefusalCode.ProtectedSelf ||
    code === DeletionRefusalCode.ProtectedStaffDomain ||
    code === DeletionRefusalCode.ProtectedHostedDomain
  ) {
    return 'This account is protected and cannot be deleted from this API';
  }
  if (code === DeletionRefusalCode.AmbiguousCloudIdentity) {
    return 'Multiple Cloud accounts match this email';
  }
  if (code === DeletionRefusalCode.NoCloudUser) {
    return 'No Cloud user exists for this email';
  }
  if (code === DeletionRefusalCode.UserHintMismatch) {
    return 'Email does not match user';
  }
  return 'User deletion could not be queued';
}
