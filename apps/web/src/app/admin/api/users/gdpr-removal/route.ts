import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { findUserById } from '@/lib/user';
import { getUserFromAuth } from '@/lib/user/server';
import { getUserDeletionRequestById, getUserDeletionRequestForUser } from '@/lib/user/deletion';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { DeletionRefusalCode } from '@/lib/user/deletion-queue/deletion-intake';

export type GdprRemovalGetResponse =
  | { error: string }
  | { request: UserDeletionRequest | null; steps: UserDeletionStep[] };

export type GdprRemovalQueuedStatus = 'enqueued' | 'already_active';

export type GdprRemovalPostResponse =
  | { error: string }
  | { requestId: string; status: GdprRemovalQueuedStatus };

export async function GET(request: NextRequest): Promise<NextResponse<GdprRemovalGetResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const requestId = request.nextUrl.searchParams.get('requestId');
  if (requestId) {
    const deletion = await getUserDeletionRequestById(requestId);
    return NextResponse.json({
      request: deletion?.request ?? null,
      steps: deletion?.steps ?? [],
    });
  }

  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) {
    return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
  }

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const deletion = await getUserDeletionRequestForUser(userId);
  return NextResponse.json({
    request: deletion?.request ?? null,
    steps: deletion?.steps ?? [],
  });
}

export async function POST(request: NextRequest): Promise<NextResponse<GdprRemovalPostResponse>> {
  const { user: admin, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const userId =
    typeof body === 'object' && body !== null && 'userId' in body && typeof body.userId === 'string'
      ? body.userId
      : undefined;

  if (!userId) {
    return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
  }

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  try {
    const [result] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: admin.id, email: admin.google_user_email },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
      catalogVersion: 2,
    });

    if (!result) {
      return NextResponse.json({ error: 'User deletion could not be queued' }, { status: 500 });
    }

    if (result.status === 'refused' || result.status === 'invalid') {
      return NextResponse.json({ error: enqueueFailureMessage(result.code) }, { status: 400 });
    }

    return NextResponse.json(
      { requestId: result.requestId, status: result.status },
      { status: 202 }
    );
  } catch (error) {
    captureException(error, {
      tags: { source: 'gdpr-removal' },
      extra: { userId },
    });
    return NextResponse.json(
      { error: 'User deletion failed — check Sentry for details' },
      { status: 500 }
    );
  }
}

function enqueueFailureMessage(code: DeletionRefusalCode): string {
  if (
    code === DeletionRefusalCode.ProtectedAdmin ||
    code === DeletionRefusalCode.ProtectedBot ||
    code === DeletionRefusalCode.ProtectedSelf
  ) {
    return 'This account is protected and cannot be deleted from this form';
  }
  if (
    code === DeletionRefusalCode.ProtectedStaffDomain ||
    code === DeletionRefusalCode.ProtectedHostedDomain
  ) {
    return 'This account is protected and cannot be deleted from this form';
  }
  if (code === DeletionRefusalCode.AmbiguousCloudIdentity) {
    return 'Multiple Cloud accounts match this email';
  }
  if (code === DeletionRefusalCode.NoCloudUser) {
    return 'No Cloud user exists for this email';
  }
  return 'User deletion could not be queued';
}
