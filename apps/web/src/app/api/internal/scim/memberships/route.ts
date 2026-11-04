import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { addDirectoryMembership, removeDirectoryMembership } from '@/lib/scim/directory-sync';
import { DirectoryMembershipSchema } from '@/lib/scim/directory-sync-contracts';
import { directorySyncErrorResponse } from '@/lib/scim/directory-sync-response';

/** Writes to the PostgreSQL primary, so it must run beside it. */
export const preferredRegion = 'fra1';

/**
 * Adds a directory user to the sub-organization its group maps to, and to that
 * sub-organization's parent. Idempotent.
 *
 * Clears a removal tombstone if one exists: for a directory-managed
 * organization the identity provider is authoritative, so a Kilo-side removal
 * does not outlive the directory's view. The response reports when that
 * happened.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const parsed = DirectoryMembershipSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    return NextResponse.json(await addDirectoryMembership(parsed.data));
  } catch (error) {
    return directorySyncErrorResponse('add membership', parsed.data.directoryGroupId, error);
  }
}

/**
 * Removes a directory user from the sub-organization its group maps to, writing
 * the removal tombstone. Idempotent.
 *
 * Only the sub-organization: a user may belong to sibling groups under the same
 * parent, so leaving one group must not revoke access to the directory's
 * organization.
 *
 * Converges instead of conflicting: a group or user Kilo never provisioned has
 * no membership to revoke, so this answers 200 with `removed: false` rather
 * than 409. Provisioning them first would create an account for a user who is
 * leaving the directory, and a 409 would hold the caller's cursor waiting for
 * an add that may never arrive. So `dsync.group.user_removed` needs no
 * prerequisite calls, unlike `dsync.group.user_added`.
 *
 * The body is read rather than taken from the path because a membership is
 * identified by a pair. `DELETE` with a body is unusual, but the alternative is
 * encoding two WorkOS identifiers into a path segment.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const parsed = DirectoryMembershipSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    return NextResponse.json(await removeDirectoryMembership(parsed.data));
  } catch (error) {
    return directorySyncErrorResponse('remove membership', parsed.data.directoryGroupId, error);
  }
}
