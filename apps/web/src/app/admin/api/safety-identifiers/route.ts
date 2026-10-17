import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { and, isNull, count, or, desc, lt, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';

const missingAny = or(
  isNull(kilocode_users.openrouter_upstream_safety_identifier),
  isNull(kilocode_users.openrouter_downstream_safety_identifier),
  isNull(kilocode_users.vercel_downstream_safety_identifier)
);

export type SafetyIdentifierCountsResponse = {
  missing: number;
};

export type BackfillBatchResponse = {
  processed: number;
  remaining: boolean;
  /** Recompute mode only: pass back as `cursor` to continue the walk. */
  cursor?: string;
};

type BackfillMode = 'missing' | 'recompute';

/**
 * `missing` (the default) fills only the identifiers that are still NULL.
 * `recompute` rewrites every row, which is what a key rotation needs: the
 * stored identifiers are derived from the deployment secret, so a changed
 * secret stops matching the identifiers the gateway sends upstream. The walk is
 * keyset-paginated on `kilocode_users.id` because a recomputed row no longer
 * changes and would otherwise be selected again.
 */
const BackfillRequestSchema = z.object({
  mode: z.enum(['missing', 'recompute']).default('missing'),
  /** The `cursor` from a previous recompute response, or the last user id processed. */
  cursor: z.string().min(1).optional(),
});

type SafetyIdentifierUpdate = {
  id: string;
  openrouter_upstream_safety_identifier: string;
  openrouter_downstream_safety_identifier: string;
  vercel_downstream_safety_identifier: string;
};

export async function GET(): Promise<
  NextResponse<SafetyIdentifierCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [result] = await db.select({ count: count() }).from(kilocode_users).where(missingAny);

  return NextResponse.json({ missing: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;

/**
 * `missing` keeps an identifier that is already stored; `recompute` overwrites
 * it, which is the only way to resync rows after the deployment secret changes.
 */
function safetyIdentifierAssignment(
  existing: AnyColumn,
  incomingColumn: string,
  mode: BackfillMode
): SQL {
  const incoming = sql.raw(`safety_identifier_updates.${incomingColumn}`);
  return mode === 'missing' ? sql`COALESCE(${existing}, ${incoming})` : incoming;
}

async function writeSafetyIdentifiers(
  updates: readonly SafetyIdentifierUpdate[],
  mode: BackfillMode
): Promise<void> {
  if (updates.length === 0) return;

  await db.execute(sql`
    UPDATE ${kilocode_users}
    SET
      openrouter_upstream_safety_identifier = ${safetyIdentifierAssignment(
        kilocode_users.openrouter_upstream_safety_identifier,
        'openrouter_upstream_safety_identifier',
        mode
      )},
      openrouter_downstream_safety_identifier = ${safetyIdentifierAssignment(
        kilocode_users.openrouter_downstream_safety_identifier,
        'openrouter_downstream_safety_identifier',
        mode
      )},
      vercel_downstream_safety_identifier = ${safetyIdentifierAssignment(
        kilocode_users.vercel_downstream_safety_identifier,
        'vercel_downstream_safety_identifier',
        mode
      )}
    FROM (VALUES ${sql.join(
      updates.map(
        update =>
          sql`(${update.id}, ${update.openrouter_upstream_safety_identifier}, ${update.openrouter_downstream_safety_identifier}, ${update.vercel_downstream_safety_identifier})`
      ),
      sql`, `
    )}) AS safety_identifier_updates(id, openrouter_upstream_safety_identifier, openrouter_downstream_safety_identifier, vercel_downstream_safety_identifier)
    WHERE ${kilocode_users.id} = safety_identifier_updates.id
  `);
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const parsed = BackfillRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  const { mode } = parsed.data;
  let cursor = parsed.data.cursor;

  let totalProcessed = 0;
  let batches = 0;
  let exhausted = false;

  while (batches < BATCHES_PER_REQUEST && !exhausted) {
    const afterCursor = cursor === undefined ? undefined : lt(kilocode_users.id, cursor);
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(mode === 'missing' ? and(missingAny, afterCursor) : afterCursor)
      .orderBy(desc(kilocode_users.id))
      .limit(BATCH_SIZE);

    batches += 1;

    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    const updates: SafetyIdentifierUpdate[] = [];
    for (const user of rows) {
      const openrouter_upstream_safety_identifier = generateOpenRouterUpstreamSafetyIdentifier(
        user.id
      );
      if (openrouter_upstream_safety_identifier === null) {
        return NextResponse.json(
          { error: 'OPENROUTER_ORG_ID is not configured on this server' },
          { status: 500 }
        );
      }
      updates.push({
        id: user.id,
        openrouter_upstream_safety_identifier,
        openrouter_downstream_safety_identifier: generateOpenRouterDownstreamSafetyIdentifier(
          user.id
        ),
        vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(user.id),
      });
    }

    await writeSafetyIdentifiers(updates, mode);

    totalProcessed += rows.length;
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) {
      exhausted = true;
    }
  }

  const response: BackfillBatchResponse = {
    processed: totalProcessed,
    remaining: !exhausted,
  };
  if (mode === 'recompute' && !exhausted && cursor !== undefined) {
    response.cursor = cursor;
  }

  return NextResponse.json(response);
}
