import { ai_gateway_config } from '@kilocode/db/schema';
import {
  LatestAliasTargetsConfigSchema,
  type LatestAliasTarget,
  type LatestAliasTargetsConfig,
} from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { MetadataDb } from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';

/**
 * How old a new target must be before an alias that already has a stored target switches to it, so
 * every launch provider serves it and a gradual BYOK rollout has reached more users.
 */
export const LATEST_ALIAS_TARGET_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type LatestAliasTargets = ReadonlyMap<string, LatestAliasTarget>;

/** Throws on an invalid stored config, so the cached getter keeps its last valid value. */
export async function readLatestAliasTargets(
  fromDb: MetadataDb = readDb
): Promise<LatestAliasTargets> {
  const [row] = await fromDb
    .select({ config: ai_gateway_config.latest_alias_targets })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.config) return new Map();
  const { aliases } = LatestAliasTargetsConfigSchema.parse(row.config);
  return new Map(aliases.map(entry => [entry.alias, entry]));
}

export const getLatestAliasTargets = createCachedFetch<LatestAliasTargets>(
  readLatestAliasTargets,
  60_000,
  new Map(),
  { name: 'latestAliasTargets' }
);

/**
 * Points every listed alias with a stored target at that target. An alias without a stored target,
 * or whose stored target is not in the map, keeps the target the gateway reports.
 */
export function applyLatestAliasTargets(
  models: GatewayModelMap,
  targets: LatestAliasTargets
): GatewayModelMap {
  if (targets.size === 0) return models;
  const result: GatewayModelMap = { ...models };
  for (const [alias, { target }] of targets) {
    const model = Object.hasOwn(models, alias) ? models[alias] : undefined;
    if (!model?.alias_target || !Object.hasOwn(models, target)) continue;
    if (model.alias_target.slug === target) continue;
    result[alias] = { ...model, alias_target: { ...model.alias_target, slug: target } };
  }
  return result;
}

/**
 * The stored targets after a refresh of the gateway's live alias targets. A new alias takes its
 * live target at once. An alias with a stored target switches to a new live target once that
 * target is `LATEST_ALIAS_TARGET_MIN_AGE_MS` old, counted from its `created` time or, when that is
 * unknown, from when the switch was first seen; until then the switch is kept as `pending`. An
 * alias whose stored target left the catalog switches at once. Aliases that left the catalog are
 * dropped.
 */
export function updateLatestAliasTargets(params: {
  previous: LatestAliasTargets;
  /** The gateway's models with their live alias targets. */
  models: GatewayModelMap;
  /** Model creation times in milliseconds since the epoch. */
  createdAtMs: ReadonlyMap<string, number>;
  nowMs: number;
}): LatestAliasTarget[] {
  const { previous, models, createdAtMs, nowMs } = params;
  const entries: LatestAliasTarget[] = [];
  for (const [alias, model] of Object.entries(models)) {
    const liveTarget = model.alias_target?.slug;
    if (!alias.startsWith('~') || liveTarget === undefined) continue;
    const stored = previous.get(alias);
    if (!Object.hasOwn(models, liveTarget)) {
      if (stored) entries.push(stored);
      continue;
    }
    if (!stored || stored.target === liveTarget || !Object.hasOwn(models, stored.target)) {
      entries.push({ alias, target: liveTarget });
      continue;
    }
    const effectiveAt =
      stored.pending?.target === liveTarget
        ? stored.pending.effective_at
        : new Date(
            (createdAtMs.get(liveTarget) ?? nowMs) + LATEST_ALIAS_TARGET_MIN_AGE_MS
          ).toISOString();
    entries.push(
      Date.parse(effectiveAt) <= nowMs
        ? { alias, target: liveTarget }
        : {
            alias,
            target: stored.target,
            pending: { target: liveTarget, effective_at: effectiveAt },
          }
    );
  }
  return entries.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

export function latestAliasTargetsConfig(
  entries: readonly LatestAliasTarget[]
): LatestAliasTargetsConfig | null {
  return entries.length === 0 ? null : LatestAliasTargetsConfigSchema.parse({ aliases: entries });
}

function formatModel(modelId: string, namesById: ReadonlyMap<string, string>) {
  const name = namesById.get(modelId);
  return name ? `${name} (\`${modelId}\`)` : `\`${modelId}\``;
}

/**
 * The description suffix that names the model an alias serves and, when a switch is pending, the
 * model it switches to and roughly when.
 */
export function describeLatestAliasTarget(params: {
  target: string;
  stored: LatestAliasTarget | undefined;
  namesById: ReadonlyMap<string, string>;
  nowMs: number;
}): string {
  const { target, stored, namesById, nowMs } = params;
  const current = `This alias currently points to ${formatModel(target, namesById)}.`;
  const pending = stored?.target === target ? stored.pending : undefined;
  if (!pending || pending.target === target) return current;
  const hours = Math.max(1, Math.round((Date.parse(pending.effective_at) - nowMs) / 3_600_000));
  return `${current} It will switch to ${formatModel(pending.target, namesById)} in approximately ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
}
