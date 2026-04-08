import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { softDeleteUserExternalServices } from '@/lib/external-services';
import { softDeleteUser, SoftDeletePreconditionError, findUserById } from '@/lib/user';
import { captureException } from '@sentry/nextjs';

type GdprRemovalResponse =
  | { error: string }
  | { success: boolean; message: string; warnings?: string[] };

export async function POST(request: NextRequest): Promise<NextResponse<GdprRemovalResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const userId =
    typeof body === 'object' && body !== null && 'userId' in body
      ? (body as Record<string, unknown>).userId
      : undefined;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
  }

  const user = await findUserById(userId);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  try {
    await softDeleteUser(userId);
  } catch (error) {
    if (error instanceof SoftDeletePreconditionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    captureException(error, {
      tags: { source: 'gdpr-removal' },
      extra: { userId },
    });
    return NextResponse.json(
      { error: 'Database deletion failed — check Sentry for details' },
      { status: 500 }
    );
  }

  const warnings = await softDeleteUserExternalServices(user);

  return NextResponse.json({
    success: true,
    message: `Account for user ${userId} has been soft-deleted and PII removed`,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
