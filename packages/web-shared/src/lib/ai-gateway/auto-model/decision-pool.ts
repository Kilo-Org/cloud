import { poolAliasTargets, type CustomRouterDefinition } from '@kilocode/auto-routing-contracts';
import { ai_gateway_config, auto_routing_custom_routers } from '@kilocode/db/schema';
import { LatestAliasTargetsConfigSchema } from '@kilocode/db/schema-types';
import {
  customRouterOwnerCondition,
  toCustomRouterDefinition,
  type CustomRouterOwner,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq } from 'drizzle-orm';

// The stored alias targets a pool may rely on, from the same statement as its definition. An
// unreadable config proves nothing, so it yields no target rather than an alias the gateway would
// then have to resolve from a moving catalog.
function storedAliasTargets(config: unknown): Map<string, string> {
  if (config === null || config === undefined) return new Map();
  const parsed = LatestAliasTargetsConfigSchema.safeParse(config);
  if (!parsed.success) return new Map();
  return new Map(parsed.data.aliases.map(alias => [alias.alias, alias.target] as const));
}

/**
 * The pool a decision routes from and the alias targets its entries may dispatch, both from one
 * primary statement. A pool's pins and an alias's stored target are routing state written in the
 * same PostgreSQL transaction, so a replica read, or two primary reads split by a promotion, could
 * serve a pool whose definition no longer matches the target the provider would resolve later. One
 * statement costs one round trip whether or not the pool has an alias, because the
 * `ai_gateway_config` row is a singleton joined by primary key.
 *
 * This lives in its own module so the two dispatch paths share one read, and a test can replace
 * exactly that boundary without replaying a query builder.
 */
export async function findDecisionPool(
  owner: CustomRouterOwner,
  slug: string
): Promise<{ router: CustomRouterDefinition; aliasTargets: Map<string, string> } | null> {
  const [row] = await db
    .select({
      router: auto_routing_custom_routers,
      aliasTargets: ai_gateway_config.latest_alias_targets,
    })
    .from(auto_routing_custom_routers)
    .leftJoin(ai_gateway_config, eq(ai_gateway_config.id, 1))
    .where(and(customRouterOwnerCondition(owner), eq(auto_routing_custom_routers.slug, slug)))
    .limit(1);
  if (!row) return null;
  const router = toCustomRouterDefinition(row.router);
  // Only this pool's own alias entries can dispatch a stored target, so the map can never name a
  // model the pool would not serve.
  return { router, aliasTargets: poolAliasTargets(router, storedAliasTargets(row.aliasTargets)) };
}
