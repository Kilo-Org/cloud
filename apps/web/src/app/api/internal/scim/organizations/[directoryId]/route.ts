import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import {
  deleteDirectoryOrganization,
  upsertDirectoryOrganization,
} from '@/lib/scim/directory-sync';
import { DirectoryOrganizationUpsertSchema } from '@/lib/scim/directory-sync-contracts';
import { directorySyncErrorResponse } from '@/lib/scim/directory-sync-response';

/** Writes to the PostgreSQL primary, so it must run beside it. */
export const preferredRegion = 'fra1';

type RouteParams = { params: Promise<{ directoryId: string }> };

/** Binds a WorkOS directory to a parent organization. Idempotent. */
export async function PUT(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const { directoryId } = await params;
  const parsed = DirectoryOrganizationUpsertSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || directoryId === '') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    return NextResponse.json(await upsertDirectoryOrganization(directoryId, parsed.data));
  } catch (error) {
    return directorySyncErrorResponse('upsert organization', directoryId, error);
  }
}

/** Soft-deletes the organization bound to a directory. Idempotent. */
export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const { directoryId } = await params;
  if (directoryId === '') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    return NextResponse.json(await deleteDirectoryOrganization(directoryId));
  } catch (error) {
    return directorySyncErrorResponse('delete organization', directoryId, error);
  }
}
