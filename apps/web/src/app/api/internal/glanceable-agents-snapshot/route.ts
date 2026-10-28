import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { buildGlanceableDeliveryForUser } from '@/lib/glanceable-agents-snapshot-server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

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
    } catch (error) {
      // The worker reads 403 as a lost scope and ends every session card in
      // it, so only a real access denial may answer 403. A database failure is
      // a 500: the worker keeps the cards and retries.
      if (
        error instanceof TRPCError &&
        (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
      ) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }
      return NextResponse.json({ error: 'Organization access check failed' }, { status: 500 });
    }
  }

  const { response, liveActivitySnapshot, sessionCards } = await buildGlanceableDeliveryForUser({
    userId,
    organizationId,
  });
  // Separate server-only envelope fields; the snapshot itself stays
  // privacy-minimal. `liveActivitySnapshot` holds the aggregate card counts
  // without the followed sessions, and `sessionCards` holds the facts of each
  // followed session card. The worker never copies either into a data-only wake.
  return NextResponse.json(
    {
      ...response.snapshot,
      homeWidgetDetails: response.details,
      liveActivitySnapshot,
      sessionCards,
    },
    { status: 200 }
  );
}
