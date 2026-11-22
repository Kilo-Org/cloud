import { ai_gateway_config } from '@kilocode/db/schema';
import type { VercelModelIdOverridesConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

/**
 * The `ai_gateway_config` singleton row's stored configuration columns.
 *
 * An absent row and a NULL column mean the same thing to every reader: that configuration is not
 * stored. The reader then returns its own built-in default, so a missing row or a never-written
 * column keeps the gateway serving instead of failing its hot path. `config` is NOT NULL, so its
 * reader meets only the absent-row case; `vercel_model_id_overrides` can also be NULL.
 *
 * Each reader selects only the one column it stores. `config` is not small — it holds the
 * organization feature lists, the Anthropic user profile lists and the routing opt-out list — so a
 * reader must not pay for the other column's bytes.
 *
 * The `id` primary key matches at most one row, so neither read needs a `limit(1)`.
 */
export async function readGatewayConfig(): Promise<Record<string, unknown> | null | undefined> {
  const [row] = await readDb
    .select({ config: ai_gateway_config.config })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1));
  return row?.config;
}

export async function readVercelModelIdOverridesConfig(): Promise<
  VercelModelIdOverridesConfig | null | undefined
> {
  const [row] = await readDb
    .select({ overrides: ai_gateway_config.vercel_model_id_overrides })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1));
  return row?.overrides;
}
