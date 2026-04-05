import type { ProfileOrganization } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user.server';
import { getProfileOrganizations } from '@/lib/organizations/organizations';
import { NextResponse } from 'next/server';

export async function GET(): Promise<
  NextResponse<
    | { error: string }
    | {
        user: { id: string; email: string; name: string; image: string };
        organizations?: ProfileOrganization[];
      }
  >
> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;

  const profileOrganizations = await getProfileOrganizations(user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.google_user_email,
      name: user.google_user_name,
      image: user.google_user_image_url,
    },
    organizations: profileOrganizations.length > 0 ? profileOrganizations : undefined,
  });
}
