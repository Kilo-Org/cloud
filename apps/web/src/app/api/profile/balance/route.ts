import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getUserFromAuth } from '@/lib/user.server';
import { NextResponse } from 'next/server';

export async function GET(): Promise<
  NextResponse<{ error: string } | { balance: number; isDepleted: boolean }>
> {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  const { balance } = await getBalanceAndOrgSettings(organizationId, user);

  return NextResponse.json({ balance, isDepleted: balance <= 0 });
}
