import { NextResponse } from 'next/server';
import { getPylonIdentity, type PylonIdentity } from '@/lib/pylon-identity';
import { getUserFromAuth } from '@/lib/user/server';

type IdentityResponse = PylonIdentity | { error: string };

export async function GET(): Promise<NextResponse<IdentityResponse>> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const identity = getPylonIdentity(user);
  if (!identity) {
    return NextResponse.json({ error: 'Pylon not configured' }, { status: 503 });
  }

  return NextResponse.json(identity);
}
