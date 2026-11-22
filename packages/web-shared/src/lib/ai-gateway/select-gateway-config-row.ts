import { ai_gateway_config } from '@kilocode/db/schema';
import { eq, type GetColumnData } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { db, DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

export type GatewayConfigRowDb = Pick<typeof db | DrizzleTransaction, 'select'>;

/**
 * The read for the organization features and the preferred models, so those two readers share one
 * selection, primary-key match and `limit(1)` instead of two copies.
 *
 * Four other readers still carry their own copy of this read for the columns they own
 * (`unavailable-models.ts`, `custom-pricing-config.ts`, `auto-model/auto-free-config.ts` and
 * `providers/latest-alias-targets.ts`). Moving them is a separate change, so this comment does not
 * claim they already use it.
 *
 * Two absences reach the caller, and a reader decides what each one means. An absent row returns
 * `undefined`. A stored NULL in a nullable column returns `null`, which is why the result is
 * `GetColumnData<TColumn> | undefined`: that type keeps `null` for a nullable column and drops it
 * for a NOT NULL one, so `config` cannot be confused with an unset value.
 *
 * `providers/ai-gateway-config-row.ts` stays separate on purpose: it deliberately omits the
 * `limit(1)` and returns hand-typed per-column values for its own readers.
 */
export async function selectGatewayConfigRow<TColumn extends PgColumn>(
  fromDb: GatewayConfigRowDb,
  column: TColumn
): Promise<GetColumnData<TColumn> | undefined> {
  const [row] = await fromDb
    .select({ value: column })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  return row?.value;
}
