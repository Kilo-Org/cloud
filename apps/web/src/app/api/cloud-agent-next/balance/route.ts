import { CLOUD_AGENT_NEXT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getUserFromAuth } from '@/lib/user/server';
import { NextResponse } from 'next/server';

export async function GET(): Promise<
  NextResponse<{ error: string } | { balance: number; isDepleted: boolean }>
> {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: CLOUD_AGENT_NEXT_AUDIENCE,
  });

  if (authFailedResponse) return authFailedResponse;

  const { balance } = await getBalanceAndOrgSettings(organizationId, user);

  return NextResponse.json({ balance, isDepleted: balance <= 0 });
}
