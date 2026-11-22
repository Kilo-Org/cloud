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
  fetchCustomRouterEpoch,
  fetchCustomRouterTable,
  fetchCustomRouterTableVersion,
  type CustomRouterTableLoad,
} from './benchmark-origin';
import { CustomRouterError, DEPENDENCY_RETRY_AFTER_SECONDS } from './caller-auth';
import type { CustomRouterOwner } from './custom-router-store';
import { customRouterDecisionScope } from './decision-cache';
import type { DecisionRun, DecisionTarget } from './decide';
import {
  contextProvablyTooSmall,
  isCapabilityActive,
  satisfiesRequiredModalities,
} from './decision-engine';
import { getModelCapabilities, type ModelCapabilities } from './model-capabilities';

const CUSTOM_ROUTER_TABLE_CACHE_TTL_MS = 60_000;
/**
 * A catalog retirement is not a pool write: it changes neither the saved definition nor the
 * benchmark readiness epoch, so only the table's own read can retire a saved pin. A pool that is
 * serving a pin therefore re-reads sooner than one with no pin to retire, which bounds how long a
 * retired target is still dispatched. A pool with no pin keeps the longer TTL.
 */
const CUSTOM_ROUTER_PINNED_TABLE_CACHE_TTL_MS = 15_000;
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
  /**
   * Entry keys whose saved pin target left the catalog. Such an entry dispatches its live alias
   * target, and only a decision that actually serves that alias is marked as the fallback.
   */
  servingFallback: Set<string>;
  /**
   * Alias id -> the concrete target the caller's snapshot stores for it. A gateway entry with no
   * usable pin dispatches whatever its alias resolves to, so that target is part of what this
   * request would run and part of what the policy must allow. Empty when the caller has no
   * snapshot (the gateway path keeps failing closed at redemption instead).
   */
  aliasTargets: ReadonlyMap<string, string>;
};

/**
 * Whether one pool entry can serve this request. Servability follows the target the entry would
 * actually dispatch, not the saved pin, because a pin is only dispatched while the benchmark worker
 * reports it usable:
 * - a client entry needs its client listed;
 * - a gateway entry whose pool model is denied or virtual never serves;
 * - a usable pin whose target is denied makes the entry unservable rather than silently unpinning
 *   it to an alias;
 * - a pin the worker reported retired is not what would run, so a denied retired pin cannot block
 *   the live alias that replaced it;
 * - every remaining case dispatches the live alias, so a denied stored target for it routes around
 *   here instead of reaching the gateway and being refused there.
 */
function entryServesRequest(
  routing: CustomRouting,
  savedEntries: ReadonlyMap<string, CustomRouterEntry>,
  clientKeys: ReadonlySet<string>,
  ref: CustomRouterEntryRef
): boolean {
  const key = customRouterEntryKey(ref);
  const saved = savedEntries.get(key);
  if (!saved) return false;
  if (saved.kind === 'client') return clientKeys.has(key);
  if (routing.deniedModelIds.has(saved.model) || isVirtualAutoModelId(saved.model)) return false;
  // A saved pin that still applies is what the entry promises, so a denied pin keeps the entry
  // out rather than silently unpinning it to an alias. Once the benchmark worker reports that
  // target left the catalog the pin is not what runs, so its denial cannot block the live alias.
  if (
    saved.servingPin !== undefined &&
    routing.deniedModelIds.has(saved.servingPin.model) &&
    !routing.servingFallback.has(key)
  ) {
    return false;
  }
  // Null only when the usable pin's own target is denied, which is a denial of what would run.
  const dispatch = customRouterEntryDispatch(saved, {
    deniedModelIds: routing.deniedModelIds,
    usablePins: routing.usablePins,
  });
  if (!dispatch) return false;
  if (dispatch.pinned) return true;
  const liveTarget = routing.aliasTargets.get(saved.model);
  return liveTarget === undefined || !routing.deniedModelIds.has(liveTarget);
}

export function customRouting(
  router: CustomRouterDefinition,
  clientEntries: ReadonlyArray<CustomRouterClientEntryId>,
  deniedModelIds: ReadonlySet<string>,
  aliasTargets: ReadonlyMap<string, string> = new Map()
): CustomRouting {
  const clientKeys = new Set(
    clientEntries.map(entry => customRouterEntryKey({ kind: 'client', ...entry }))
  );
  const savedEntries = new Map(
    router.entries.map(entry => [customRouterEntryKey(entry), entry] as const)
  );
  const routing: CustomRouting = {
    router,
    deniedModelIds,
    usablePins: new Map(),
    servingFallback: new Set<string>(),
    aliasTargets,
    isServable: ref => entryServesRequest(routing, savedEntries, clientKeys, ref),
  };
  return routing;
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

type CachedTableEntry = {
  load: CustomRouterTableLoad;
  /**
   * The router epoch this table was built under, or null when the deployment could not prove one.
   * Only an epoch match may serve the cache without re-reading the pool; an entry with no epoch is
   * never served from cache.
   */
  epoch: number | null;
  /** The pool fingerprint checked at the last epoch mismatch, when the refresh ran the probe. */
  version: string | null;
  /** When this table was built; the hard staleness bound for what the epoch does not cover. */
  builtAt: number;
  /** Insertion order of the build that produced this entry, so an older finishing build loses. */
  sequence: number;
};

const tableCache = new Map<string, CachedTableEntry>();
/**
 * One in-flight rebuild per context. Two requests that arrive while the same pool is being rebuilt
 * share it, so a burst of traffic after a publish costs one epoch read and one table fetch.
 */
const tableRefreshes = new Map<string, Promise<CustomRouterTableLoad>>();

export function clearCustomRouterTableCache(): void {
  tableCache.clear();
  tableRefreshes.clear();
}

let cacheSequence = 0;

function cacheEntry(key: string, entry: CachedTableEntry): void {
  const existing = tableCache.get(key);
  // A build that started before the cached one must never replace it: a slow pre-settlement
  // rebuild finishing late would otherwise downgrade the rank every later request serves. A
  // monotonic sequence is used because two builds can start within the same millisecond.
  if (existing && existing.sequence > entry.sequence) return;
  tableCache.set(key, entry);
  if (tableCache.size <= CUSTOM_ROUTER_TABLE_CACHE_LIMIT) return;
  const oldest = tableCache.keys().next().value;
  if (oldest !== undefined && oldest !== key) tableCache.delete(oldest);
}

/**
 * The table a pool serves. The benchmark Worker's per-router readiness epoch is the authority: it
 * advances inside the same D1 transaction as every committed readiness or provenance change, so a
 * pool whose epoch matches its cached table serves immediately and a pool whose epoch moved
 * re-checks before serving. The first routing request after a settlement therefore sees the new
 * rank; there is no blind interval and no KV in the path.
 *
 * Costs and fail-closed rules:
 * - one exact-key epoch read per route through the existing benchmark service binding;
 * - a mismatch falls back to the existing per-pool fingerprint, so only the pools whose ready set
 *   actually changed rebuild (an alias, catalog, or client-only change keeps its cached table);
 * - the 60 s TTL still bounds what the epoch and fingerprint do not cover (catalog prices); a pool
 *   serving a pin re-reads at 15 s, because a catalog retirement writes no epoch and no pool row;
 * - an unprovable epoch (older benchmark Worker answering 404 during a staggered deploy, a 5xx, an
 *   unreadable body) never reads as "unchanged": the actual table is fetched on that request,
 *   single-flighted so a burst shares one fetch, and it is never cached as proof, so a later 503
 *   cannot resurrect an older rank. A failed table fetch is the retryable routing failure it was.
 */
async function loadCustomRouterTable(
  env: Env,
  router: CustomRouterDefinition
): Promise<CustomRouterTableLoad> {
  const context = customRouterBenchmarkContext(router);
  const key = JSON.stringify(context);
  const epoch = await fetchCustomRouterEpoch(env, router.baseRouter);
  const cached = tableCache.get(key);
  const cacheTtl =
    cached && (cached.load.servingPins.size > 0 || cached.load.servingFallback.size > 0)
      ? CUSTOM_ROUTER_PINNED_TABLE_CACHE_TTL_MS
      : CUSTOM_ROUTER_TABLE_CACHE_TTL_MS;
  if (cached && epoch !== null && Date.now() - cached.builtAt < cacheTtl) {
    if (cached.epoch === epoch) return cached.load;
    // The router's registry moved. Only this pool's own ready set decides whether it rebuilds, and
    // the record of that check must not extend `builtAt`: the hard TTL still has to expire so
    // catalogue and pricing changes refresh.
    const version = await fetchCustomRouterTableVersion(env, context);
    if (version !== null && version === cached.version) {
      if (cached.epoch === null || epoch > cached.epoch) {
        cacheEntry(key, { ...cached, epoch });
      }
      return cached.load;
    }
  }
  // An unprovable epoch (an older benchmark Worker answering 404 during a staggered deploy, a 5xx,
  // an unreadable body) is never treated as proof: the actual table is fetched on this request. It
  // is single-flighted per context so a burst shares one fetch, and it is cached as unknown so a
  // later 503 cannot keep serving a table that a previous 404 let us keep.
  const flightKey = `${key}\u0000${epoch ?? 'unproven'}`;
  const inFlight = tableRefreshes.get(flightKey);
  if (inFlight) return inFlight;
  cacheSequence += 1;
  const sequence = cacheSequence;
  const startedAt = Date.now();
  const refresh = (async (): Promise<CustomRouterTableLoad> => {
    // Fingerprint before the table: a change landing after it advances the epoch again, so the next
    // request re-checks instead of trusting this build.
    const version = await fetchCustomRouterTableVersion(env, context);
    const load = await fetchCustomRouterTable(env, context);
    cacheEntry(key, { load, epoch, version, builtAt: startedAt, sequence });
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
      // A failed table read is a retryable routing failure. Serving the previous table would be
      // exactly the pre-settlement lie the epoch exists to prevent.
      throw new CustomRouterError(
        'internal_error',
        'Custom router table is temporarily unavailable',
        DEPENDENCY_RETRY_AFTER_SECONDS
      );
    })
    .finally(() => {
      tableRefreshes.delete(flightKey);
    });
  tableRefreshes.set(flightKey, refresh);
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
      routing.servingFallback = new Set(loaded.servingFallback);
      const routingTable = servableRoutingTable(loaded.table, routing);
      timings.tableMs = performance.now() - tableStartedAt;
      const capabilitiesStartedAt = performance.now();
      const gatewayCapabilities = await getModelCapabilities(env, {
        router: router.baseRouter,
        waitUntil,
        // An alias entry is served as its concrete target, whose capabilities are the ones that
        // decide modality and context fit; the pool model itself may be an alias with no row.
        // That target is the saved pin while the benchmark worker still serves it, otherwise the
        // live target this caller's snapshot stores for the alias.
        additionalModelIds: router.entries.flatMap(entry => {
          if (entry.kind !== 'gateway' || isDirectByokModelId(entry.model)) return [];
          const liveTarget = routing.aliasTargets.get(entry.model);
          return [
            entry.model,
            ...(entry.servingPin ? [entry.servingPin.model] : []),
            ...(liveTarget === undefined ? [] : [liveTarget]),
          ];
        }),
      });
      timings.capabilitiesMs = performance.now() - capabilitiesStartedAt;
      const capabilities = new Map(gatewayCapabilities);
      for (const entry of router.entries) {
        const caps = entryCapabilities(entry);
        if (caps) {
          capabilities.set(customRouterCandidateModel(entry), caps);
          continue;
        }
        // A gateway entry's own row comes from the map above when the id has one. An alias id has
        // none (aliases never appear in `model_stats`), so rank and filter the logical pool entry
        // with the concrete model it would run: the saved pin the worker still serves, otherwise
        // the live target this caller's snapshot stores for the alias. A bare alias whose target
        // this request cannot name keeps no row here and is resolved or refused at redemption.
        if (entry.kind !== 'gateway') continue;
        const dispatchModel = entry.servingPin?.model ?? routing.aliasTargets.get(entry.model);
        const dispatchCaps =
          dispatchModel === undefined ? undefined : gatewayCapabilities.get(dispatchModel);
        if (dispatchCaps) capabilities.set(customRouterCandidateModel(entry), dispatchCaps);
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

/**
 * True when this target is the live alias of a pinned entry whose saved concrete target left the
 * catalog. Only then may a decision name the bare alias for a pinned entry, and only then does the
 * wire marker appear; a pin the worker still serves and a denied target both stay unmarked.
 */
function servesRetiredPinFallback(
  routing: CustomRouting,
  entry: CustomRouterEntry,
  target: { model: string; servingPin?: CustomRouterServingPin }
): { servingFallback?: true } {
  return entry.kind === 'gateway' &&
    entry.servingPin !== undefined &&
    target.servingPin === undefined &&
    target.model === entry.model &&
    routing.servingFallback.has(customRouterEntryKey(entry))
    ? { servingFallback: true }
    : {};
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
          ...servesRetiredPinFallback(routing, poolEntry, target),
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
    ...servesRetiredPinFallback(routing, fallback.entry, fallback.target),
  };
}

// Same capability rules as the decision engine, without its largest-context rescue: a
// fallback entry with no active capability row, that lacks a required modality, or that is
// provably too small fails. Client and direct-BYOK entries carry their own active row.
function fitsRequest(entry: CustomRouterEntry, run: DecisionRun): boolean {
  const caps = run.capabilities.get(customRouterCandidateModel(entry));
  if (!isCapabilityActive(caps)) return false;
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
    ...(decision.servingFallback ? { servingFallback: true } : {}),
    variant: decision.variant ?? decision.reasoningEffort ?? null,
    stale: decision.stale ?? false,
    fallback: decision.fallback ?? false,
    sticky: decision.sticky,
    taskType: decision.taskType,
    subtaskType: decision.subtaskType,
    tableVersion: decision.tableVersion,
  };
}
