import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { buildGlanceableSnapshotForUser } from '@/lib/glanceable-agents-snapshot-server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { TRPCContext } from '@/lib/trpc/init';

const SECRET_COMPARE_HMAC_KEY = Buffer.from('glanceable-agents-snapshot-secret-compare');

const BodySchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
  })
  .strict();

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const left = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(provided).digest();
  const right = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Internal server-to-server snapshot builder for background glanceable
 * delivery. The notifications worker is the only caller; mobile never calls
 * this route. Requires the internal secret, and — when `organizationId` is a
 * string — re-checks that `userId` is a member of that organization with the
 * same helper the active-sessions router uses, so a compromised worker cannot
 * read another user's org snapshot.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || !secretMatches(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody: unknown = await req.json().catch(() => null);
  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { userId, organizationId } = parsedBody.data;

  if (typeof organizationId === 'string') {
    try {
      await ensureOrganizationAccess(
        { user: { id: userId, is_admin: false } } as unknown as TRPCContext,
        organizationId
      );
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
  }

  const snapshot = await buildGlanceableSnapshotForUser({ userId, organizationId });
  return NextResponse.json(snapshot, { status: 200 });
}
