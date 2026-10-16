/**
 * Internal API: the auto-routing worker's ADR 0005 cutover posts saved owner pools for
 * efficient, and each becomes the owner's `efficient` custom router.
 *
 * Auth: shared internal secret over `Authorization: Bearer <secret>`.
 *
 * URL: POST /api/internal/auto-routing/owner-pool-conversions
 */

import { OwnerPoolConversionRequestSchema } from '@kilocode/auto-routing-contracts';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { convertOwnerPools } from '@/lib/auto-routing-owner-pool-conversion';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await req.json().catch(() => null);
  const parsed = OwnerPoolConversionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return NextResponse.json(await convertOwnerPools(parsed.data));
}
