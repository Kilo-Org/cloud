import { successResult } from '@/lib/maybe-result';
import { getUserFromAuth } from '@/lib/user.server';
import { revokeWebSessions } from '@/lib/web-session-revocation';
import { NextResponse } from 'next/server';

export async function POST() {
  const { user } = await getUserFromAuth({
    adminOnly: false,
    DANGEROUS_allowBlockedUsers: true,
  });

  if (user) {
    await revokeWebSessions(user.id);
  }

  return NextResponse.json(successResult());
}
