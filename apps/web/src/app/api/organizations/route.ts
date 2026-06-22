import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getProfileOrganizations } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string } | { organizations: { id: string; name: string }[] }>> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const organizations = await getProfileOrganizations(user.id);

  return NextResponse.json({
    organizations: organizations.map(organization => ({
      id: organization.id,
      name: organization.name,
    })),
  });
}
