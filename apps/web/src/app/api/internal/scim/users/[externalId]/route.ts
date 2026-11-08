import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { upsertDirectoryUser } from '@/lib/scim/directory-sync';
import { DirectoryUserUpsertSchema } from '@/lib/scim/directory-sync-contracts';
import { directorySyncErrorResponse } from '@/lib/scim/directory-sync-response';

/** Creates a Stripe customer and writes to the primary, so it runs beside it. */
export const preferredRegion = 'fra1';

type RouteParams = { params: Promise<{ externalId: string }> };

/**
 * Binds a WorkOS directory user to a Kilo user, creating one if no existing
 * account matches. Idempotent.
 *
 * There is no DELETE. A directory user leaving a directory is not an account
 * deletion: `softDeleteUser` anonymizes the account, rotates credentials, and
 * refuses outright when a live subscription or KiloClaw instance exists. A
 * `dsync.user.deleted` event removes the user's directory memberships instead,
 * through the memberships route.
 */
export async function PUT(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const { externalId } = await params;
  const parsed = DirectoryUserUpsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || externalId === '') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    return NextResponse.json(await upsertDirectoryUser(externalId, parsed.data));
  } catch (error) {
    return directorySyncErrorResponse('upsert user', externalId, error);
  }
}
