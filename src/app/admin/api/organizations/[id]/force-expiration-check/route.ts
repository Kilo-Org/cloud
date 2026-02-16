import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { processOrganizationExpirations } from '@/lib/creditExpiration';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ success: boolean } | { error: string }>> {
  const id = (await params).id;
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const org = await getOrganizationById(id);
  if (!org) {
    return NextResponse.json({ error: 'Organization not found: ' + id }, { status: 404 });
  }

  await processOrganizationExpirations(
    {
      id: org.id,
      microdollars_used: org.microdollars_used,
      next_credit_expiration_at: org.next_credit_expiration_at,
      total_microdollars_acquired: org.total_microdollars_acquired,
    },
    new Date()
  );

  return NextResponse.json({ success: true });
}
