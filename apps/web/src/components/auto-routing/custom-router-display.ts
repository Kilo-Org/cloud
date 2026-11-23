import {
  AUTO_ROUTING_CUSTOM_ROUTERS_PATH,
  AUTO_ROUTING_PLATFORM_MEASUREMENTS_PATH,
  PlatformMeasurementsResponseSchema,
  CustomRouterErrorResponseSchema,
  CustomRouterListResponseSchema,
  CustomRouterResponseSchema,
  customRouterPath,
  type AutoRouter,
  type AutoRoutingMode,
  type CustomRouterEntryRef,
  type CustomRouterListEntry,
  type CustomRouterListResponse,
  type OwnerType,
  type CustomRouterSummary,
  type PaidBenchmarkProgress,
} from '@kilocode/auto-routing-contracts';

export const BASE_ROUTER_OPTIONS: Array<{ value: AutoRouter; label: string }> = [
  { value: 'efficient', label: 'Efficient' },
  { value: 'frontier', label: 'Frontier' },
];

export const MODE_OPTIONS: Array<{ value: AutoRoutingMode; label: string }> = [
  { value: 'cost_per_accuracy', label: 'Best accuracy per dollar' },
  { value: 'best_accuracy', label: 'Best accuracy' },
  { value: 'cheapest', label: 'Cheapest' },
];

export const CUSTOM_ROUTERS_POLL_INTERVAL_MS = 15_000;

export function customRoutersQueryKey(organizationId: string | undefined) {
  return ['auto-routing-custom-routers', organizationId ?? 'personal'] as const;
}

function withOrganization(path: string, organizationId: string | undefined): string {
  return organizationId ? `${path}?${new URLSearchParams({ organizationId })}` : path;
}

export function customRoutersEndpoint(organizationId: string | undefined): string {
  return withOrganization(AUTO_ROUTING_CUSTOM_ROUTERS_PATH, organizationId);
}

export function customRouterItemEndpoint(
  scope: OwnerType,
  slug: string,
  organizationId: string | undefined
): string {
  return withOrganization(customRouterPath(scope, slug), organizationId);
}

export async function fetchPlatformMeasurements(
  baseRouter: AutoRouter,
  organizationId: string | undefined
) {
  const params = new URLSearchParams({ router: baseRouter });
  if (organizationId) params.set('organizationId', organizationId);
  const response = await fetch(`${AUTO_ROUTING_PLATFORM_MEASUREMENTS_PATH}?${params}`);
  if (!response.ok) throw new Error(await errorMessage(response));
  return PlatformMeasurementsResponseSchema.parse(await response.json());
}

export function entryLabel(entry: CustomRouterEntryRef): string {
  return entry.kind === 'gateway' ? entry.model : `${entry.provider}/${entry.model}`;
}

async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = CustomRouterErrorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error.message : `Request failed (HTTP ${response.status})`;
}

export async function fetchCustomRouters(
  organizationId: string | undefined
): Promise<CustomRouterListResponse> {
  const response = await fetch(customRoutersEndpoint(organizationId));
  if (!response.ok) throw new Error(await errorMessage(response));
  return CustomRouterListResponseSchema.parse(await response.json());
}

export async function readCustomRouterResponse(response: Response): Promise<CustomRouterSummary> {
  if (!response.ok) throw new Error(await errorMessage(response));
  return CustomRouterResponseSchema.parse(await response.json()).router;
}

export async function deleteCustomRouter(
  router: Pick<CustomRouterSummary, 'scope' | 'slug'>,
  organizationId: string | undefined
): Promise<void> {
  const response = await fetch(
    customRouterItemEndpoint(router.scope, router.slug, organizationId),
    {
      method: 'DELETE',
    }
  );
  if (!response.ok) throw new Error(await errorMessage(response));
}

export type RoutingStatusKind =
  | 'active'
  | 'active-old-target'
  | 'active-older-benchmark'
  | 'benchmarking'
  | 'paused'
  | 'failed'
  | 'permanently-failed'
  | 'not-benchmarked'
  | 'unavailable'
  | 'needs-client-eval'
  | 'unknown';

export type EntryRoutingStatus = {
  kind: RoutingStatusKind;
  label: string;
  detail: string | null;
  /** The entry serves at least one route in this pool right now. */
  active: boolean;
  /** The owner has to run this pool's benchmark again to change this row. */
  rebenchmarkNeeded: boolean;
  tone: 'default' | 'muted' | 'warning' | 'destructive';
};

export type PausedRequestInfo = {
  reason: string | null;
  /**
   * Concrete models the paused request affects, from the server's summary.
   * Undefined when an older Worker cannot report them, so the caller can fall
   * back without claiming every model is affected.
   */
  models: readonly string[] | undefined;
};

type EntryRoutingInputs = {
  aliasTargets?: ReadonlyMap<string, string>;
  /** The pool's latest benchmark request is paused, with the models it covers. */
  paused?: PausedRequestInfo | null;
};

/**
 * The paused request's affected models come from the server's summary, never
 * from one loaded page of case rows: a large pool's later pages are not read
 * here. An older Worker omits the summary, so the rows stay neutral instead of
 * claiming a model is paused.
 */
export function pausedRequestInfo(progress: PaidBenchmarkProgress): PausedRequestInfo | null {
  if (progress.status !== 'paused') return null;
  return { reason: progress.reason, models: progress.pausedModels };
}

/**
 * Only ready/stale rows serve. The backend reports a usable old measurement as
 * ready/stale before any running row, so a lone `running` row is a first
 * measurement and serves nothing yet.
 */
function servesNow(entry: CustomRouterListEntry): boolean {
  return entry.variants.some(variant => variant.status === 'ready' || variant.status === 'stale');
}

/**
 * What one pool row is doing in routing right now. The states are exclusive and
 * overlap is expressed as detail: a row can serve comfortably, serve on an old
 * pinned target that needs another benchmark, serve older measurements, be
 * measuring, be paused, be permanently failed, or not be benchmarked at all.
 * A model nobody asked to measure is never presented as benchmarking or paused.
 *
 * Every state here is derived from rows the status API really sends: a permanent
 * failure is `variant.failure.kind === 'permanent'` or `availability:
 * 'permanent_failure'`, never a list-level `blocker` field no producer fills.
 */
export function entryRoutingStatus(
  entry: CustomRouterListEntry,
  inputs: EntryRoutingInputs = {}
): EntryRoutingStatus {
  const { variants } = entry;
  const label = entryLabel(entry.entry);
  const pin =
    entry.servingPin ??
    (entry.entry.kind === 'gateway' ? entry.entry.servingPin : undefined) ??
    null;
  const serving = servesNow(entry);
  const running = variants.some(
    variant => variant.status === 'pending' || variant.status === 'running'
  );

  const permanent = variants.find(
    variant => variant.failure?.kind === 'permanent' || variant.availability === 'permanent_failure'
  );
  if (permanent !== undefined) {
    const reason =
      permanent.failure?.reason ??
      permanent.failureReason ??
      permanent.failure?.failureClass ??
      'The benchmark permanently failed';
    return {
      kind: 'permanently-failed',
      label: 'Permanently failed',
      detail: `${reason}.${
        serving
          ? ' Routing still uses its last usable measurement.'
          : ' It cannot serve this pool; replace it or choose another model.'
      }`,
      active: serving,
      rebenchmarkNeeded: false,
      tone: 'destructive',
    };
  }

  // The saved pin's target is gone from the catalog, so the live alias target
  // serves instead. This must come before the plain "not benchmarked" fallback:
  // a dead pin on an unmeasured target is exactly the case the owner must see.
  const fallbackVariant = variants.find(variant => variant.servingFallback === true);
  if (fallbackVariant !== undefined) {
    const benchmarked = pin?.model ?? null;
    const servedTarget =
      fallbackVariant.servingModel ?? inputs.aliasTargets?.get(entry.entry.model) ?? null;
    const target = servedTarget ?? "the alias's current target";
    const targetState = serving
      ? `Routing uses ${target}, which is measured in this pool.`
      : running
        ? `Requests go to ${target}; it is being measured now.`
        : `Requests go to ${target}, which has no measurement in this pool.`;
    return {
      kind: 'unavailable',
      label: serving ? 'Serving new alias target' : 'Benchmarked target no longer served',
      detail: [
        benchmarked !== null
          ? `The benchmarked target ${benchmarked} is no longer served.`
          : 'The benchmarked target for this alias is no longer served.',
        targetState,
        'Benchmark this pool again to pin the current target.',
      ].join(' '),
      active: serving,
      rebenchmarkNeeded: true,
      tone: serving ? 'warning' : 'destructive',
    };
  }

  if (running) {
    return {
      kind: 'benchmarking',
      label: entry.entry.kind === 'client' ? 'Measuring here' : 'Benchmarking',
      detail: serving
        ? `Measuring ${label}. Routing keeps using its current measurement until this finishes.`
        : `Measuring ${label}. It cannot serve a route until this finishes.`,
      active: serving,
      rebenchmarkNeeded: false,
      tone: 'default',
    };
  }

  if (inputs.paused != null && inputs.paused.models !== undefined && !serving) {
    const pausedModels = inputs.paused.models;
    const pausedModel =
      pausedModels.includes(label) ||
      (pin !== null && pausedModels.includes(pin.model)) ||
      variants.some(
        variant => variant.resolvedModel != null && pausedModels.includes(variant.resolvedModel)
      );
    if (pausedModel) {
      return {
        kind: 'paused',
        label: 'Paused',
        detail:
          inputs.paused.reason ??
          'Benchmarking is paused. Start it again to continue measuring this model.',
        active: false,
        rebenchmarkNeeded: true,
        tone: 'warning',
      };
    }
  }

  if (variants.length === 0) {
    return {
      kind: 'unknown',
      label: 'Status unavailable',
      detail: null,
      active: false,
      rebenchmarkNeeded: false,
      tone: 'muted',
    };
  }

  const failed = variants.find(variant => variant.status === 'failed');
  if (failed !== undefined) {
    return {
      kind: 'failed',
      label: serving ? 'Active · benchmark failed' : 'Benchmark failed',
      detail: `${failed.failureReason ?? failed.failure?.reason ?? 'No reason was recorded.'}${
        serving
          ? ' Routing keeps its last usable measurement.'
          : ' Benchmark this pool again to retry it.'
      }`,
      active: serving,
      rebenchmarkNeeded: !serving,
      tone: serving ? 'warning' : 'destructive',
    };
  }

  if (entry.needsClientEval) {
    return {
      kind: 'needs-client-eval',
      label: 'Not measured here',
      detail: 'Run the client eval from the CLI to measure this model in this pool.',
      active: false,
      rebenchmarkNeeded: false,
      tone: 'muted',
    };
  }

  if (!serving) {
    return {
      kind: 'not-benchmarked',
      label: 'Not benchmarked yet',
      detail: 'It cannot serve a route until this pool benchmarks it.',
      active: false,
      rebenchmarkNeeded: false,
      tone: 'muted',
    };
  }

  const liveTarget = inputs.aliasTargets?.get(entry.entry.model) ?? null;
  if (pin !== null && liveTarget !== null && liveTarget !== pin.model) {
    return {
      kind: 'active-old-target',
      label: 'Active on old target',
      detail: [
        `Serving the benchmarked ${pin.model};`,
        `the alias now resolves to ${liveTarget}.`,
        'Benchmark this pool again to follow the alias.',
      ].join(' '),
      active: true,
      rebenchmarkNeeded: true,
      tone: 'warning',
    };
  }

  if (variants.some(variant => variant.status === 'stale')) {
    return {
      kind: 'active-older-benchmark',
      label: 'Active · older benchmark',
      detail: [
        'Routing uses its measurement from an older benchmark.',
        'It ranks in this pool; benchmark again to refresh it.',
      ].join(' '),
      active: true,
      rebenchmarkNeeded: true,
      tone: 'warning',
    };
  }

  return {
    kind: 'active',
    label: 'Active',
    detail: 'Serving routes from this pool.',
    active: true,
    rebenchmarkNeeded: false,
    tone: 'default',
  };
}

/**
 * True while a row can flip without the owner clicking: not measured yet,
 * queued/measuring, or a status a later global measurement can replace. This is
 * what lets another pool's published result turn this pool's row Active.
 */
export function hasUnsettledEntries(routers: CustomRouterSummary[]): boolean {
  return routers.some(router =>
    router.entries.some(entry => {
      const kind = entryRoutingStatus(entry).kind;
      return (
        kind === 'not-benchmarked' ||
        kind === 'benchmarking' ||
        kind === 'failed' ||
        kind === 'unknown'
      );
    })
  );
}
