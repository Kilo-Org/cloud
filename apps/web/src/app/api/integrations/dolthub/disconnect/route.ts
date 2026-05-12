import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { uninstall } from '@/lib/integrations/dolthub-service';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * DoltHub OAuth Disconnect
 *
 * Removes the DoltHub integration for the authenticated user or organization.
 *
 * Query parameters:
 * - organizationId: (optional) Organization ID for org-owned integrations
 */
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return authFailedResponse;
    }

    const searchParams = request.nextUrl.searchParams;
    const organizationId = searchParams.get('organizationId');

    let owner: Owner;

    if (organizationId) {
      await ensureOrganizationAccess({ user }, organizationId);
      owner = { type: 'org', id: organizationId };
    } else {
      owner = { type: 'user', id: user.id };
    }

    await uninstall(owner);

    return NextResponse.json({ success: true });
  } catch (error) {
    captureException(error, {
      tags: {
        endpoint: 'dolthub/disconnect',
        source: 'dolthub_oauth',
      },
    });

    return NextResponse.json({ error: 'disconnect_failed' }, { status: 500 });
  }
}
