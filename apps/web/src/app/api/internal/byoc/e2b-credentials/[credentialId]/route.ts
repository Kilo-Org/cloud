import { organization_e2b_compute_credentials } from '@kilocode/db/schema';
import { parseKeyedEnvelope, timingSafeEqual } from '@kilocode/encryption';
import { and, eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { toE2BComputeStatus } from '@/lib/e2b-client';

const responseHeaders = { 'Cache-Control': 'no-store' };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ credentialId: string }> }
): Promise<NextResponse> {
  const presented = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !presented || !timingSafeEqual(presented, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders });
  }

  const { credentialId } = await params;
  const organizationId = z.uuid().safeParse(request.nextUrl.searchParams.get('organizationId'));
  if (!z.uuid().safeParse(credentialId).success || !organizationId.success) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400, headers: responseHeaders }
    );
  }

  const row = await db.query.organization_e2b_compute_credentials.findFirst({
    where: and(
      eq(organization_e2b_compute_credentials.id, credentialId),
      eq(organization_e2b_compute_credentials.organization_id, organizationId.data)
    ),
  });
  if (!row) {
    return NextResponse.json(
      { error: 'Credential not found' },
      { status: 404, headers: responseHeaders }
    );
  }

  try {
    const status = toE2BComputeStatus(row);
    const apiKeyEncrypted = parseKeyedEnvelope(
      JSON.stringify(row.api_key_encrypted),
      'byoc-e2b-credential-rsa-aes-256-gcm'
    );
    return NextResponse.json({ ...status, apiKeyEncrypted }, { headers: responseHeaders });
  } catch {
    return NextResponse.json(
      { error: 'E2B credential is invalid' },
      { status: 503, headers: responseHeaders }
    );
  }
}
