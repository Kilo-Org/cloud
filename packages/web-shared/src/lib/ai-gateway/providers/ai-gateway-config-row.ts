import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

/**
 * The configuration columns of the `ai_gateway_config` singleton row that the gateway reads on its
 * request path. Both columns are small admin-written values, so one read serves every cached getter
 * instead of one query per column.
 */
const aiGatewayConfigColumns = {
  config: ai_gateway_config.config,
  vercelModelIdOverrides: ai_gateway_config.vercel_model_id_overrides,
} as const;

/**
 * The `ai_gateway_config` singleton row's configuration columns, or `undefined` when the row is
 * absent.
 *
 * An absent row and a NULL column mean the same thing to every reader: that configuration is not
 * stored. The reader then returns its own built-in default, so a missing row or a never-written
 * column keeps the gateway serving instead of failing its hot path. `config` is NOT NULL, so its
 * readers meet only the absent-row case; `vercel_model_id_overrides` can also be NULL.
 *
 * The `id` primary key matches at most one row, so the read needs no `limit(1)`.
 */
export async function readAiGatewayConfigRow() {
  const [row] = await readDb
    .select(aiGatewayConfigColumns)
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1));
  return row;
}
