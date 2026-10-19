import { NextResponse, type NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { GLANCEABLE_SNAPSHOT_SIGNING_SECRET } from '@kilocode/web-shared/lib/config.server';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { verifyGlanceableSnapshotCredential } from '@kilocode/worker-utils/glanceable-snapshot-credential';
import { buildGlanceableDeliveryForUser } from '@/lib/glanceable-agents-snapshot-server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const BodySchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
  })
  .strict();

function logSnapshotAudit(
  outcome:
    | 'ok'
    | 'unauthorized'
    | 'forbidden'
    | 'invalid_request'
    | 'unavailable'
    | 'access_denied'
    | 'access_check_failed',
  status: number,
  startedAt: number,
  organizationScoped: boolean
): void {
  console.log(
    JSON.stringify({
      type: 'glanceable_agents_snapshot',
      outcome,
      status,
      durationMs: Date.now() - startedAt,
      organizationScoped,
    })
  );
}

/**
 * Internal server-to-server snapshot builder for background glanceable
 * delivery. The notifications worker is the only caller; mobile never calls
 * this route. The bearer is a short-lived credential whose subject is the
 * authorized user, and — when `organizationId` is a string — the route
 * re-checks that subject is a member of that organization with the same
 * helper the active-sessions router uses.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  if (!GLANCEABLE_SNAPSHOT_SIGNING_SECRET) {
    logSnapshotAudit('unavailable', 503, startedAt, false);
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 503, headers: NO_STORE }
    );
  }

  const token = extractBearerToken(req.headers.get('authorization'));
  if (!token) {
    logSnapshotAudit('unauthorized', 401, startedAt, false);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const credential = await verifyGlanceableSnapshotCredential({
    token,
    secret: GLANCEABLE_SNAPSHOT_SIGNING_SECRET,
  });
  if (!credential.ok) {
    logSnapshotAudit('unauthorized', 401, startedAt, false);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const rawBody: unknown = await req.json().catch(() => null);
  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    logSnapshotAudit('invalid_request', 400, startedAt, false);
    return NextResponse.json({ error: 'Invalid body' }, { status: 400, headers: NO_STORE });
  }

  const { userId, organizationId } = parsedBody.data;
  if (userId !== credential.userId) {
    logSnapshotAudit('forbidden', 403, startedAt, organizationId !== null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE });
  }

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
        logSnapshotAudit('access_denied', 403, startedAt, true);
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: NO_STORE });
      }
      logSnapshotAudit('access_check_failed', 500, startedAt, true);
      return NextResponse.json(
        { error: 'Organization access check failed' },
        { status: 500, headers: NO_STORE }
      );
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
  logSnapshotAudit('ok', 200, startedAt, organizationId !== null);
  return NextResponse.json(
    {
      ...response.snapshot,
      homeWidgetDetails: response.details,
      liveActivitySnapshot,
      sessionCards,
    },
    { status: 200, headers: NO_STORE }
  );
}
