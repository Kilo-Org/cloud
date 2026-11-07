import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { revokeAllDirectoryMemberships } from '@/lib/scim/directory-sync';
import { directorySyncErrorResponse } from '@/lib/scim/directory-sync-response';

/** Writes to the PostgreSQL primary, so it must run beside it. */
export const preferredRegion = 'fra1';

type RouteParams = { params: Promise<{ externalId: string }> };

/**
 * Revokes every directory membership the account bound to a directory user
 * holds: the group organizations, and their parents once no group under them
 * remains. Idempotent.
 *
 * This is what a `dsync.user.deleted` applies, and a `dsync.user.updated` that
 * reports the user `inactive` — most identity providers soft-delete, so
 * `inactive` is the common offboarding signal.
 *
 * It does not delete the account. `softDeleteUser` anonymizes it, rotates its
 * credentials, and refuses outright when a live subscription or KiloClaw
 * instance exists; none of that is a directory event's to authorize, so the
 * sibling user route exposes no DELETE either.
 *
 * No body: the directory user in the path identifies everything to revoke.
 *
 * Converges instead of conflicting: an `externalId` no account is bound to has
 * nothing to revoke, which is the state the event asserts, so this answers 200
 * with `kiloUserId: null` and an empty list rather than 409 — exactly as the
 * single membership DELETE does, so a replay is a no-op.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const { externalId } = await params;
  if (externalId === '') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    return NextResponse.json(await revokeAllDirectoryMemberships(externalId));
  } catch (error) {
    return directorySyncErrorResponse('revoke all memberships', externalId, error);
  }
}
