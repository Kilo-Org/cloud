import {
  customRouterCandidateModel,
  customRouterEntryKey,
  customRouterEntryRef,
  customRouterModelId,
  isVirtualAutoModelId,
  parseCustomRouterCandidateModel,
  type AutoRoutingDecision,
  type CustomRouterClientEntryId,
  type CustomRouterDecision,
  type CustomRouterDefinition,
  type CustomRouterEntry,
  type CustomRouterEntryRef,
  type CustomRouterReference,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { formatError, ttlCached, type TtlCache } from '@kilocode/worker-utils';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import { customRouterBenchmarkContext, fetchCustomRouterTable } from './benchmark-origin';
import { CustomRouterError } from './caller-auth';
import type { CustomRouterOwner } from './custom-router-store';
import { customRouterDecisionScope } from './decision-cache';
import type { DecisionRun, DecisionTarget } from './decide';
import { getModelCapabilities, type ModelCapabilities } from './model-capabilities';

const CUSTOM_ROUTER_TABLE_CACHE_TTL_MS = 60_000;
const CUSTOM_ROUTER_TABLE_CACHE_LIMIT = 1_000;

// A router owned by an organization resolves only in that organization's context.
export function customRouterOwner(
  reference: CustomRouterReference,
  caller: { userId: string; organizationId: string | null }
): CustomRouterOwner | null {
  if (reference.scope === 'user') return { type: 'user', id: caller.userId };
  return caller.organizationId === null ? null : { type: 'org', id: caller.organizationId };
}

// What one request may route to: the pool entries this client can dispatch, minus denied models.
export type CustomRouting = {
  router: CustomRouterDefinition;
  isServable: (entry: CustomRouterEntryRef) => boolean;
  deniedModelIds: ReadonlySet<string>;
};

export function customRouting(
  router: CustomRouterDefinition,
  clientEntries: ReadonlyArray<CustomRouterClientEntryId>,
  deniedModelIds: ReadonlySet<string>
): CustomRouting {
  const poolKeys = new Set(router.entries.map(customRouterEntryKey));
  const clientKeys = new Set(
    clientEntries.map(entry => customRouterEntryKey({ kind: 'client', ...entry }))
  );
  return {
    router,
    deniedModelIds,
    isServable: entry => {
      const key = customRouterEntryKey(entry);
      if (!poolKeys.has(key)) return false;
      if (entry.kind === 'client') return clientKeys.has(key);
      return !deniedModelIds.has(entry.model) && !isVirtualAutoModelId(entry.model);
    },
  };
}

const tableLoaders = new Map<string, TtlCache<Env, RoutingTable | null>>();

export function clearCustomRouterTableCache(): void {
  tableLoaders.clear();
}

async function loadCustomRouterTable(
  env: Env,
  router: CustomRouterDefinition
): Promise<RoutingTable | null> {
  const context = customRouterBenchmarkContext(router);
  const key = JSON.stringify(context);
  let loader = tableLoaders.get(key);
  if (!loader) {
    loader = ttlCached(CUSTOM_ROUTER_TABLE_CACHE_TTL_MS, (e: Env) =>
      fetchCustomRouterTable(e, context)
    );
    tableLoaders.set(key, loader);
    if (tableLoaders.size > CUSTOM_ROUTER_TABLE_CACHE_LIMIT) {
      const oldest = tableLoaders.keys().next().value;
      if (oldest !== undefined) tableLoaders.delete(oldest);
    }
  }
  return loader.get(env).catch((error: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_custom_router_table_read_failed',
        customRouterId: router.id,
        ...formatError(error),
      })
    );
    return null;
  });
}

// Drops every candidate outside the pool or not servable by this client, then empty routes.
export function servableRoutingTable(
  table: RoutingTable | null,
  routing: CustomRouting
): RoutingTable | null {
  if (!table) return null;
  const routes: RoutingTable['routes'] = {};
  for (const [routeKey, candidates] of Object.entries(table.routes)) {
    const servable = candidates.filter(candidate => {
      const entry = parseCustomRouterCandidateModel(candidate.model);
      return entry !== null && routing.isServable(entry);
    });
    if (servable.length > 0) routes[routeKey] = servable;
  }
  return { ...table, routes };
}

// Client entries carry their own capabilities. Kilo-stored direct-BYOK models have no
// model_stats row; they stay routable and fail closed only on required modalities.
function entryCapabilities(entry: CustomRouterEntry): ModelCapabilities | null {
  if (entry.kind === 'client') {
    return {
      inputModalities: new Set(entry.capabilities.inputModalities),
      contextLength: entry.capabilities.contextLength,
      isActive: true,
    };
  }
  return isDirectByokModelId(entry.model)
    ? { inputModalities: new Set(), contextLength: null, isActive: true }
    : null;
}

export function customRouterTarget(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  routing: CustomRouting
): DecisionTarget {
  const { router } = routing;
  return {
    scope: customRouterDecisionScope(router.id),
    requestedModel: customRouterModelId(router.ownerType, router.slug),
    deniedModelIds: routing.deniedModelIds,
    loadRouting: async timings => {
      const tableStartedAt = performance.now();
      const routingTable = servableRoutingTable(await loadCustomRouterTable(env, router), routing);
      timings.tableMs = performance.now() - tableStartedAt;
      const capabilitiesStartedAt = performance.now();
      const gatewayCapabilities = await getModelCapabilities(env, {
        router: router.baseRouter,
        waitUntil,
        additionalModelIds: router.entries.flatMap(entry =>
          entry.kind === 'gateway' && !isDirectByokModelId(entry.model) ? [entry.model] : []
        ),
      });
      timings.capabilitiesMs = performance.now() - capabilitiesStartedAt;
      const capabilities = new Map(gatewayCapabilities);
      for (const entry of router.entries) {
        const caps = entryCapabilities(entry);
        if (caps) capabilities.set(customRouterCandidateModel(entry), caps);
      }
      return {
        routingMode: router.mode,
        capabilities,
        routingTable,
        shadowRoutingTable: null,
        customTable: true,
      };
    },
  };
}

function fallbackVariant(entry: CustomRouterEntry): string | null {
  return entry.kind === 'client' ? (entry.variants[0] ?? null) : null;
}

// A custom router never routes outside its pool: a null decision takes the default entry, then
// the first entry this client can serve (ADR 0005).
export function customRouterDecision(
  routing: CustomRouting,
  run: DecisionRun
): AutoRoutingDecision {
  const decision = run.response.decision;
  if (decision) {
    const entry = parseCustomRouterCandidateModel(decision.model);
    if (entry && routing.isServable(entry)) {
      return { ...decision, entry, stale: decision.stale ?? false, fallback: false };
    }
  }
  const { entries, defaultEntryKey } = routing.router;
  const fallback = [
    ...entries.filter(entry => customRouterEntryKey(entry) === defaultEntryKey),
    ...entries,
  ].find(entry => routing.isServable(entry));
  if (!fallback) {
    throw new CustomRouterError(
      'custom_router_unavailable',
      'No entry of this custom router is available to this client'
    );
  }
  const classification = run.response.classifierResult?.classification ?? null;
  const entry = customRouterEntryRef(fallback);
  return {
    model: customRouterCandidateModel(entry),
    entry,
    variant: fallbackVariant(fallback),
    taskType: classification?.taskType ?? null,
    subtaskType: classification?.subtaskType ?? null,
    source: 'benchmark',
    tableVersion: run.routingTable?.version ?? null,
    sticky: false,
    switchReason: null,
    stale: false,
    fallback: true,
  };
}

export function publicCustomRouterDecision(decision: AutoRoutingDecision): CustomRouterDecision {
  const entry = decision.entry ?? parseCustomRouterCandidateModel(decision.model);
  if (!entry) throw new Error(`custom router decision ${decision.model} names no pool entry`);
  return {
    entry,
    model: decision.model,
    variant: decision.variant ?? decision.reasoningEffort ?? null,
    stale: decision.stale ?? false,
    fallback: decision.fallback ?? false,
    sticky: decision.sticky,
    taskType: decision.taskType,
    subtaskType: decision.subtaskType,
    tableVersion: decision.tableVersion,
  };
}
