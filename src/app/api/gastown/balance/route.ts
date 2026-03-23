import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getBalanceForUser } from '@/lib/user.balance';
import { getBalanceForOrganizationUser } from '@/lib/organizations/organization-usage';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';

/**
 * GET /api/gastown/balance?organizationId=<optional>
 *
 * Returns the user's dollar balance for the gas tank gauge.
 * When organizationId is provided, returns the org-scoped balance.
 * Authenticated via NextAuth session cookie (same-origin).
 */
export async function GET(request: Request) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const hasAccess = await isGastownEnabled(user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: 'Gastown access denied' }, { status: 403 });
  }

  const url = new URL(request.url);
  const organizationId = url.searchParams.get('organizationId');

  const { balance } = organizationId
    ? await getBalanceForOrganizationUser(organizationId, user.id)
    : await getBalanceForUser(user, { quiet: true });

  return NextResponse.json({ balance });
}
