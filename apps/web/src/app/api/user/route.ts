import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { NextResponse } from 'next/server';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';

export async function GET(): Promise<
  NextResponse<{ error: string } | User | { id: string; cloudAgentAuthority: CloudAgentAuthority }>
> {
  const { user, authFailedResponse, cloudAgentAuthority } = await getUserFromAuth({
    adminOnly: false,
    requestPathname: '/api/user',
  });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  return NextResponse.json(cloudAgentAuthority ? { id: user.id, cloudAgentAuthority } : user);
}
