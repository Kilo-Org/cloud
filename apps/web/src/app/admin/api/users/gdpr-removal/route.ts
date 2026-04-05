import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { softDeleteUserExternalServices } from '@/lib/external-services';
import { softDeleteUser, SoftDeletePreconditionError, findUserById } from '@/lib/user';

export async function POST(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { success: boolean; message: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { userId } = await request.json();

  if (!userId) {
    return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
  }

  const user = await findUserById(userId);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  try {
    await softDeleteUser(userId);
    await softDeleteUserExternalServices(user);
  } catch (error) {
    if (error instanceof SoftDeletePreconditionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  return NextResponse.json({
    success: true,
    message: `Account for user ${userId} has been soft-deleted and PII removed`,
  });
}
