import { organization_e2b_compute_credentials } from '@kilocode/db/schema';
import { timingSafeEqual } from '@kilocode/encryption';
import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { toE2BComputeStatus } from '@/lib/e2b-client';

const responseHeaders = { 'Cache-Control': 'no-store' };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> }
): Promise<NextResponse> {
  const presented = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !presented || !timingSafeEqual(presented, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders });
  }

  const { organizationId } = await params;
  if (!z.uuid().safeParse(organizationId).success) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400, headers: responseHeaders }
    );
  }

  const row = await db.query.organization_e2b_compute_credentials.findFirst({
    where: eq(organization_e2b_compute_credentials.organization_id, organizationId),
    columns: { api_key_encrypted: false },
  });
  if (!row) {
    return NextResponse.json(
      { error: 'Credential not found' },
      { status: 404, headers: responseHeaders }
    );
  }

  try {
    return NextResponse.json(toE2BComputeStatus(row), { headers: responseHeaders });
  } catch {
    return NextResponse.json(
      { error: 'E2B credential is invalid' },
      { status: 503, headers: responseHeaders }
    );
  }
}
