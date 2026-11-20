import {
  customRouterCandidateModel,
  customRouterEntryDispatch,
  customRouterEntryKey,
  customRouterModelId,
  isVirtualAutoModelId,
  parseCustomRouterCandidateModel,
  toCustomRouterEntryRef,
  type AutoRoutingDecision,
  type CustomRouterClientEntryId,
  type CustomRouterDecision,
  type CustomRouterDefinition,
  type CustomRouterEntry,
  type CustomRouterEntryRef,
  type CustomRouterReference,
  type CustomRouterServingPin,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import {
  customRouterBenchmarkContext,
  fetchCustomRouterTable,
  fetchCustomRouterTableVersion,
} from './benchmark-origin';
import { CustomRouterError } from './caller-auth';
import type { CustomRouterOwner } from './custom-router-store';
import { customRouterDecisionScope } from './decision-cache';
import type { DecisionRun, DecisionTarget } from './decide';
import { contextProvablyTooSmall, satisfiesRequiredModalities } from './decision-engine';
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
// A pinned entry dispatches its pinned concrete target, which the benchmark worker reported as
// usable; the logical pool entry stays the ranking and policy identity.
export type CustomRouting = {
  router: CustomRouterDefinition;
  isServable: (entry: CustomRouterEntryRef) => boolean;
  deniedModelIds: ReadonlySet<string>;
  /** Entry key -> concrete target this request may dispatch for that pinned entry. */
  usablePins: Map<string, string>;
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
  const usablePins = new Map<string, string>();
  return {
    router,
    deniedModelIds,
    usablePins,
    isServable: entry => {
      const key = customRouterEntryKey(entry);
      if (!poolKeys.has(key)) return false;
      if (entry.kind === 'client') return clientKeys.has(key);
      return !deniedModelIds.has(entry.model) && !isVirtualAutoModelId(entry.model);
    },
  };
}

/**
 * The model a chosen entry dispatches and the pin that proves it, or null when this request cannot
 * serve the entry. A pin applies only after the benchmark worker reported it usable and only when
 * neither the pool model nor the pinned target is denied.
 */
export function customRouterEntryTarget(
  routing: CustomRouting,
  entry: CustomRouterEntry
): { model: string; servingPin?: CustomRouterServingPin } | null {
  const dispatch = customRouterEntryDispatch(entry, {
    deniedModelIds: routing.deniedModelIds,
    usablePins: routing.usablePins,
  });
  if (!dispatch) return null;
  if (!dispatch.pinned) return { model: dispatch.model };
  const pin = entry.kind === 'gateway' ? entry.servingPin : undefined;
  return pin ? { model: dispatch.model, servingPin: pin } : { model: dispatch.model };
}

type CustomRouterTableLoad = {
  table: RoutingTable | null;
  servingPins: ReadonlyMap<string, string>;
};

type CachedTableEntry = {
  load: CustomRouterTableLoad;
  /** The canonical benchmark version this table was built from, when the probe answered. */
  version: string | null;
  /** When this table was built; the hard staleness bound for changes the probe does not cover. */
  builtAt: number;
  /** When the version probe last ran, answered or not, so a probe outage is not retried per request. */
  probedAt: number;
};

const tableCache = new Map<string, CachedTableEntry>();
/**
 * One in-flight rebuild per context. Two requests that arrive while the same pool is being rebuilt
 * share it; a request that arrives after it finishes re-checks the canonical version first.
 */
const tableRefreshes = new Map<string, Promise<CustomRouterTableLoad>>();
/**
 * How often one context re-checks the canonical version. A newly ready measurement therefore
 * becomes visible to every pool sharing it within seconds, while a burst of requests for the same
 * pool costs one probe per interval instead of one per request.
 */
const CUSTOM_ROUTER_VERSION_CHECK_MS = 5_000;

export function clearCustomRouterTableCache(): void {
  tableCache.clear();
  tableRefreshes.clear();
}

function cacheEntry(key: string, entry: CachedTableEntry): void {
  tableCache.set(key, entry);
  if (tableCache.size <= CUSTOM_ROUTER_TABLE_CACHE_LIMIT) return;
  const oldest = tableCache.keys().next().value;
  if (oldest !== undefined && oldest !== key) tableCache.delete(oldest);
}

/**
 * The table a pool serves, refreshed as soon as the benchmark worker's readiness fingerprint for it
 * changes — a newly ready measurement becomes visible to every pool that shares the concrete
 * target, without a click, a request or a charge for those owners.
 *
 * Correctness without unbounded D1 work:
 * - a cached table is reused while the cheap fingerprint matches it and it is younger than the
 *   table TTL, so anything the fingerprint does not cover (catalog prices) still refreshes;
 * - a probe failure keeps serving the current table for at most the TTL, so a probe outage
 *   degrades to the previous behaviour instead of rebuilding once per request;
 * - one probe per context per few seconds, and one coalesced rebuild shared by simultaneous
 *   requests, bound the extra load to a constant independent of request rate.
 */
async function loadCustomRouterTable(
  env: Env,
  router: CustomRouterDefinition
): Promise<CustomRouterTableLoad> {
  const context = customRouterBenchmarkContext(router);
  const key = JSON.stringify(context);
  const cached = tableCache.get(key);
  const now = Date.now();
  if (cached) {
    if (now - cached.probedAt >= CUSTOM_ROUTER_VERSION_CHECK_MS) {
      const version = await fetchCustomRouterTableVersion(env, context);
      cached.probedAt = Date.now();
      // A matching readiness fingerprint means the ready set is unchanged. The hard TTL still
      // applies, so anything the fingerprint does not cover (catalog prices) refreshes as before.
      const afterProbe = Date.now();
      if (
        version !== null &&
        version === cached.version &&
        afterProbe - cached.builtAt < CUSTOM_ROUTER_TABLE_CACHE_TTL_MS
      ) {
        return cached.load;
      }
      if (version === null && afterProbe - cached.builtAt < CUSTOM_ROUTER_TABLE_CACHE_TTL_MS) {
        // Probe outage: keep the table the TTL allows rather than rebuilding once per request.
        return cached.load;
      }
    } else if (now - cached.builtAt < CUSTOM_ROUTER_TABLE_CACHE_TTL_MS) {
      return cached.load;
    }
  }
  const inFlight = tableRefreshes.get(key);
  if (inFlight) return inFlight;
  const refresh = (async (): Promise<CustomRouterTableLoad> => {
    // Read the fingerprint first: a publish that lands after this read is caught by the next
    // probe, and a table built from that state is never mistaken for an older one.
    const version = await fetchCustomRouterTableVersion(env, context);
    const load = await fetchCustomRouterTable(env, context);
    const at = Date.now();
    cacheEntry(key, { load, version, builtAt: at, probedAt: at });
    return load;
  })()
    .catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'auto_routing_custom_router_table_read_failed',
          customRouterId: router.id,
          ...formatError(error),
        })
      );
      const previous = tableCache.get(key);
      if (previous) {
        previous.probedAt = Date.now();
        return previous.load;
      }
      return { table: null, servingPins: new Map<string, string>() };
    })
    .finally(() => {
      tableRefreshes.delete(key);
    });
  tableRefreshes.set(key, refresh);
  return refresh;
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
  routing: CustomRouting,
  requestedModel = customRouterModelId(routing.router.ownerType, routing.router.slug)
): DecisionTarget {
  const { router } = routing;
  return {
    scope: customRouterDecisionScope(router.id),
    requestedModel,
    deniedModelIds: routing.deniedModelIds,
    loadRouting: async timings => {
      const tableStartedAt = performance.now();
      const loaded = await loadCustomRouterTable(env, router);
      // The benchmark worker is the authority on which pins still have a usable measurement.
      routing.usablePins = new Map(loaded.servingPins);
      const routingTable = servableRoutingTable(loaded.table, routing);
      timings.tableMs = performance.now() - tableStartedAt;
      const capabilitiesStartedAt = performance.now();
      const gatewayCapabilities = await getModelCapabilities(env, {
        router: router.baseRouter,
        waitUntil,
        // A pinned entry is served as its concrete target, whose capabilities are the ones that
        // decide modality and context fit; the pool model itself may be an alias with no row.
        additionalModelIds: router.entries.flatMap(entry =>
          entry.kind === 'gateway' && !isDirectByokModelId(entry.model)
            ? [entry.model, ...(entry.servingPin ? [entry.servingPin.model] : [])]
            : []
        ),
      });
      timings.capabilitiesMs = performance.now() - capabilitiesStartedAt;
      const capabilities = new Map(gatewayCapabilities);
      for (const entry of router.entries) {
        const caps = entryCapabilities(entry);
        if (caps) {
          capabilities.set(customRouterCandidateModel(entry), caps);
          continue;
        }
        const pinnedCaps =
          entry.kind === 'gateway' && entry.servingPin
            ? gatewayCapabilities.get(entry.servingPin.model)
            : undefined;
        // Rank and filter the logical pool entry with its pinned target's capabilities.
        if (pinnedCaps) capabilities.set(customRouterCandidateModel(entry), pinnedCaps);
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

function findPoolEntry(
  routing: CustomRouting,
  ref: CustomRouterEntryRef
): CustomRouterEntry | undefined {
  const key = customRouterEntryKey(ref);
  return routing.router.entries.find(entry => customRouterEntryKey(entry) === key);
}

// A custom router never routes outside its pool: a null decision takes the default entry, then
// the first entry this client can serve that fits the request (ADR 0005). A pinned entry
// dispatches its benchmarked concrete target, including on the fallback path.
export function customRouterDecision(
  routing: CustomRouting,
  run: DecisionRun
): AutoRoutingDecision {
  const decision = run.response.decision;
  if (decision) {
    const ref = parseCustomRouterCandidateModel(decision.model);
    const poolEntry = ref ? findPoolEntry(routing, ref) : undefined;
    if (ref && poolEntry && routing.isServable(ref)) {
      const target = customRouterEntryTarget(routing, poolEntry);
      if (target) {
        return {
          ...decision,
          model: target.model,
          ...(target.servingPin ? { servingPin: target.servingPin } : {}),
          entry: ref,
          stale: decision.stale ?? false,
          fallback: false,
        };
      }
    }
  }
  const { entries, defaultEntryKey } = routing.router;
  const fallback = [
    ...entries.filter(entry => customRouterEntryKey(entry) === defaultEntryKey),
    ...entries,
  ]
    .filter(entry => routing.isServable(toCustomRouterEntryRef(entry)) && fitsRequest(entry, run))
    .map(entry => ({ entry, target: customRouterEntryTarget(routing, entry) }))
    .find(candidate => candidate.target !== null);
  if (!fallback?.target) {
    throw new CustomRouterError(
      'custom_router_unavailable',
      'No entry of this custom router is available to this client'
    );
  }
  const classification = run.response.classifierResult?.classification ?? null;
  return {
    model: fallback.target.model,
    ...(fallback.target.servingPin ? { servingPin: fallback.target.servingPin } : {}),
    entry: toCustomRouterEntryRef(fallback.entry),
    variant: fallbackVariant(fallback.entry),
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

// Same capability rules as the decision engine, without its largest-context rescue: a
// fallback entry that is inactive, lacks a required modality, or is provably too small fails.
function fitsRequest(entry: CustomRouterEntry, run: DecisionRun): boolean {
  const caps = run.capabilities.get(customRouterCandidateModel(entry));
  if (caps?.isActive === false) return false;
  if (run.constraints === undefined) return true;
  return (
    satisfiesRequiredModalities(caps, run.constraints) &&
    !contextProvablyTooSmall(caps, run.constraints)
  );
}

export function publicCustomRouterDecision(decision: AutoRoutingDecision): CustomRouterDecision {
  const entry = decision.entry ?? parseCustomRouterCandidateModel(decision.model);
  if (!entry) throw new Error(`custom router decision ${decision.model} names no pool entry`);
  return {
    entry,
    model: decision.model,
    ...(decision.servingPin ? { servingPin: decision.servingPin } : {}),
    variant: decision.variant ?? decision.reasoningEffort ?? null,
    stale: decision.stale ?? false,
    fallback: decision.fallback ?? false,
    sticky: decision.sticky,
    taskType: decision.taskType,
    subtaskType: decision.subtaskType,
    tableVersion: decision.tableVersion,
  };
}
