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
import { findUserByEmailCaseInsensitive } from '@/lib/user';
import {
  authorizeSupportRequest,
  hashSupportTargetEmail,
  parseActorEmail,
  RequestIdSchema,
} from '../_auth';

const EmailQuerySchema = z.string().trim().toLowerCase().email();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeSupportRequest(request);
  if (unauthorized) return unauthorized;

  const actorEmail = parseActorEmail(request.headers.get('x-actor-email'));
  if (actorEmail === null) {
    return NextResponse.json({ error: 'Invalid actorEmail' }, { status: 400 });
  }

  const requestIdParsed = RequestIdSchema.safeParse(request.headers.get('x-request-id'));
  if (!requestIdParsed.success) {
    return NextResponse.json({ error: 'Invalid requestId' }, { status: 400 });
  }
  const requestId = requestIdParsed.data;

  const emailParsed = EmailQuerySchema.safeParse(request.nextUrl.searchParams.get('email'));
  if (!emailParsed.success) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }
  const email = emailParsed.data;

  const emit = (params: { outcome: SupportServiceOutcome; targetUserId?: string }): void => {
    emitSupportServiceAccessEvent({
      method: 'GET',
      route: routeFromHeaders(request.headers),
      ip: clientIpFromHeaders(request.headers),
      claimedActorEmail: actorEmail,
      correlationId: requestId,
      outcome: params.outcome,
      target: params.targetUserId ? userTarget(params.targetUserId) : null,
      targetEmailHash: hashSupportTargetEmail(email),
    });
  };

  try {
    const matches = await findUserByEmailCaseInsensitive(email);
    if (matches.length > 1) {
      emit({ outcome: 'conflict' });
      return NextResponse.json({ error: 'Multiple users match this email' }, { status: 409 });
    }

    const user = matches[0];
    if (!user || isSoftDeletedBlockedReason(user.blocked_reason)) {
      emit({ outcome: 'not_found', targetUserId: user?.id });
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    emit({ outcome: 'found', targetUserId: user.id });
    return NextResponse.json({
      id: user.id,
      email: user.google_user_email,
      name: user.google_user_name,
      createdAt: new Date(user.created_at).toISOString(),
      isBlocked: Boolean(user.blocked_reason),
    });
  } catch (error) {
    captureException(error, { tags: { source: 'support-user-lookup' } });
    emit({ outcome: 'error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
