import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { db, DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

export type GatewayConfigRowDb = Pick<typeof db | DrizzleTransaction, 'select'>;

/**
 * The one place the `ai_gateway_config` singleton row's `id = 1` read lives, so every reader
 * shares the same selection, primary-key match and `limit(1)`.
 *
 * An absent row returns `undefined` rather than a built-in value: each caller applies its own
 * default, because a missing row means "not configured" to all of them.
 *
 * `providers/ai-gateway-config-row.ts` stays separate on purpose: it deliberately omits the
 * `limit(1)` and returns hand-typed per-column values for its own readers.
 */
export async function selectGatewayConfigRow<TColumn extends PgColumn>(
  fromDb: GatewayConfigRowDb,
  column: TColumn
): Promise<TColumn['_']['data'] | undefined> {
  const [row] = await fromDb
    .select({ value: column })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  return row?.value;
}
