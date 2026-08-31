import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { KILO_AUTO_BALANCED_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { ORGANIZATION_ID_HEADER } from '@/lib/constants';
import { GET as getOrganizationDefaults } from '@/app/api/organizations/[id]/defaults/route';

type DefaultsResponse = {
  defaultModel: string;
  defaultFreeModel: string | null;
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<DefaultsResponse | { error: string }>> {
  const organizationId = request.headers.get(ORGANIZATION_ID_HEADER);
  if (organizationId !== null) {
    return getOrganizationDefaults(request, { params: Promise.resolve({ id: organizationId }) });
  }

  return NextResponse.json({
    defaultModel: KILO_AUTO_BALANCED_MODEL.id,
    defaultFreeModel: KILO_AUTO_FREE_MODEL.id,
  });
}
