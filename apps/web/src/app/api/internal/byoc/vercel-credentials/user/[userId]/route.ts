import { timingSafeEqual } from '@kilocode/encryption';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { byoc_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

import { decodeVercelConnection } from '@/lib/byoc/vercel-connection';

const responseHeaders = { 'Cache-Control': 'no-store' };

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const presented = request.headers.get('x-internal-api-key');
  const expected = presented ? await readInternalApiSecret() : '';
  if (!expected || !presented || !timingSafeEqual(presented, expected)) return false;
  observeInternalAuth(
    'web',
    'byoc_vercel_credentials_user',
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );
  return true;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders });
  }

  const { userId } = await params;
  if (!z.string().min(1).safeParse(userId).success) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400, headers: responseHeaders }
    );
  }

  const connection = await db.query.byoc_connections.findFirst({
    where: and(eq(byoc_connections.provider, 'vercel'), eq(byoc_connections.user_id, userId)),
  });
  if (!connection) {
    return NextResponse.json(
      { error: 'Credential not found' },
      { status: 404, headers: responseHeaders }
    );
  }

  const row = decodeVercelConnection(connection);
  return NextResponse.json(
    {
      credentialId: row.id,
      userId: row.user_id,
      setupStatus: row.setup_status,
      setupStep: row.setup_step,
      setupError: row.setup_error,
      buildGeneration: row.build_generation,
      runtimeBuildId: row.runtime_build_id,
      runtimeSnapshotId: row.runtime_snapshot_id,
      runtimeDigest: row.runtime_digest,
      teamSlug: row.team_slug,
      projectSlug: row.project_slug,
    },
    { headers: responseHeaders }
  );
}
