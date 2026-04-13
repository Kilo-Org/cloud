import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { successResult } from '@/lib/maybe-result';
import { revokeWebSession } from '@/lib/web-session-revocation';

export async function POST() {
  const { user } = await getUserFromAuth({
    adminOnly: false,
    DANGEROUS_allowBlockedUsers: true,
  });

  if (user) {
    await revokeWebSession(user.id);
  }

  return NextResponse.json(successResult());
}
