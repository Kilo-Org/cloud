import { timingSafeEqual } from '@kilocode/encryption';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { organization_vercel_compute_credentials } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

const responseHeaders = { 'Cache-Control': 'no-store' };

function isAuthorized(request: NextRequest): boolean {
  const presented = request.headers.get('x-internal-api-key');
  return Boolean(
    INTERNAL_API_SECRET && presented && timingSafeEqual(presented, INTERNAL_API_SECRET)
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders });
  }

  const { organizationId } = await params;
  if (!z.uuid().safeParse(organizationId).success) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400, headers: responseHeaders }
    );
  }

  const row = await db.query.organization_vercel_compute_credentials.findFirst({
    where: eq(organization_vercel_compute_credentials.organization_id, organizationId),
    columns: {
      id: true,
      organization_id: true,
      setup_status: true,
      setup_step: true,
      setup_error: true,
      build_generation: true,
      runtime_build_id: true,
      runtime_snapshot_id: true,
      team_slug: true,
      project_slug: true,
    },
  });
  if (!row) {
    return NextResponse.json(
      { error: 'Credential not found' },
      { status: 404, headers: responseHeaders }
    );
  }

  return NextResponse.json(
    {
      credentialId: row.id,
      organizationId: row.organization_id,
      setupStatus: row.setup_status,
      setupStep: row.setup_step,
      setupError: row.setup_error,
      buildGeneration: row.build_generation,
      runtimeBuildId: row.runtime_build_id,
      runtimeSnapshotId: row.runtime_snapshot_id,
      teamSlug: row.team_slug,
      projectSlug: row.project_slug,
    },
    { headers: responseHeaders }
  );
}
