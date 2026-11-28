import { timingSafeEqual } from '@kilocode/encryption';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { byoc_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const querySchema = z
  .object({ provider: z.literal('aws'), credentialId: z.uuid().optional() })
  .and(
    z.union([
      z.object({ organizationId: z.uuid(), userId: z.never().optional() }),
      z.object({ organizationId: z.never().optional(), userId: z.string().min(1) }),
    ])
  );
const headers = { 'Cache-Control': 'no-store' };

/** The Worker receives only the selected owner's encrypted connection. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const presented = request.headers.get('x-internal-api-key');
  const expected = presented ? await readInternalApiSecret() : '';
  if (!expected || !presented || !timingSafeEqual(presented, expected))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  observeInternalAuth(
    'web',
    'byoc_connections',
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers });
  const input = parsed.data;
  const owner =
    input.organizationId !== undefined
      ? eq(byoc_connections.organization_id, input.organizationId)
      : eq(byoc_connections.user_id, input.userId);
  const row = await db.query.byoc_connections.findFirst({
    where: and(
      eq(byoc_connections.provider, input.provider),
      owner,
      ...(input.credentialId ? [eq(byoc_connections.id, input.credentialId)] : [])
    ),
  });
  if (!row) return NextResponse.json({ error: 'Connection not found' }, { status: 404, headers });
  return NextResponse.json(
    {
      credentialId: row.id,
      setupStatus: row.setup_status,
      credentialsEncrypted: row.credentials_encrypted,
      ...(row.organization_id !== null
        ? { organizationId: row.organization_id }
        : { userId: row.user_id }),
    },
    { headers }
  );
}
