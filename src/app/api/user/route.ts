import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@/lib/user.server';
import { NextResponse } from 'next/server';

export async function GET(): Promise<NextResponse<{ error: string } | User>> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  return NextResponse.json(user);
}
