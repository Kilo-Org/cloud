import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import {
  deleteDirectorySubOrganization,
  upsertDirectorySubOrganization,
} from '@/lib/scim/directory-sync';
import { DirectorySubOrganizationUpsertSchema } from '@/lib/scim/directory-sync-contracts';
import { directorySyncErrorResponse } from '@/lib/scim/directory-sync-response';

/** Writes to the PostgreSQL primary, so it must run beside it. */
export const preferredRegion = 'fra1';

type RouteParams = { params: Promise<{ directoryGroupId: string }> };

/**
 * Binds a WorkOS directory group to a sub-organization under the organization
 * that owns the directory. Idempotent, and applies renames on repeat.
 */
export async function PUT(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const { directoryGroupId } = await params;
  const parsed = DirectorySubOrganizationUpsertSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || directoryGroupId === '') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    return NextResponse.json(await upsertDirectorySubOrganization(directoryGroupId, parsed.data));
  } catch (error) {
    return directorySyncErrorResponse('upsert sub-organization', directoryGroupId, error);
  }
}

/** Soft-deletes the sub-organization bound to a directory group. Idempotent. */
export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const { directoryGroupId } = await params;
  if (directoryGroupId === '') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    return NextResponse.json(await deleteDirectorySubOrganization(directoryGroupId));
  } catch (error) {
    return directorySyncErrorResponse('delete sub-organization', directoryGroupId, error);
  }
}
