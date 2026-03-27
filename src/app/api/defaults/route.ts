import { NextResponse } from 'next/server';
import { KILO_AUTO_BALANCED_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto-model';
import { getFraudDetectionHeaders, isRooCodeBasedClient } from '@/lib/utils';
import { headers } from 'next/headers';
import { getUserFromAuth } from '@/lib/user.server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { readDb } from '@/lib/drizzle';

type DefaultsResponse = {
  defaultModel: string;
  defaultFreeModel: string;
};

export async function GET(): Promise<NextResponse<DefaultsResponse>> {
  if (isRooCodeBasedClient(getFraudDetectionHeaders(await headers()))) {
    const { user, organizationId } = await getUserFromAuth({ adminOnly: false });
    if (user) {
      const { balance } = await getBalanceAndOrgSettings(organizationId, user, readDb);
      if (balance <= 0) {
        return NextResponse.json({
          defaultModel: KILO_AUTO_FREE_MODEL.id,
          defaultFreeModel: KILO_AUTO_FREE_MODEL.id,
        });
      }
    }
  }
  return NextResponse.json({
    defaultModel: KILO_AUTO_BALANCED_MODEL.id,
    defaultFreeModel: KILO_AUTO_FREE_MODEL.id,
  });
}
