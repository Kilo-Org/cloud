import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { NextResponse } from 'next/server';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import { toClientUser, type ClientUser } from '@/lib/user/client-user';

export async function GET(): Promise<
  NextResponse<
    { error: string } | ClientUser | { id: string; cloudAgentAuthority: CloudAgentAuthority }
  >
> {
  const { user, authFailedResponse, cloudAgentAuthority } = await getUserFromAuth({
    adminOnly: false,
    requestPathname: '/api/user',
  });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  return NextResponse.json(
    cloudAgentAuthority ? { id: user.id, cloudAgentAuthority } : toClientUser(user)
  );
}
