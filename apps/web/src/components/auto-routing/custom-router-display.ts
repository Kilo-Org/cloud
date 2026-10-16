import {
  AUTO_ROUTING_CUSTOM_ROUTERS_PATH,
  CustomRouterErrorResponseSchema,
  CustomRouterListResponseSchema,
  CustomRouterResponseSchema,
  customRouterPath,
  type AutoRouter,
  type AutoRoutingMode,
  type CustomRouterEntryRef,
  type CustomRouterListEntry,
  type CustomRouterListResponse,
  type CustomRouterScope,
  type CustomRouterSummary,
} from '@kilocode/auto-routing-contracts';

export const BASE_ROUTER_OPTIONS: Array<{ value: AutoRouter; label: string }> = [
  { value: 'efficient', label: 'Efficient' },
  { value: 'frontier', label: 'Frontier' },
];

export const MODE_OPTIONS: Array<{ value: AutoRoutingMode; label: string }> = [
  { value: 'cost_per_accuracy', label: 'Best accuracy per dollar' },
  { value: 'best_accuracy', label: 'Best accuracy' },
];

export const CUSTOM_ROUTERS_POLL_INTERVAL_MS = 15_000;

function withOrganization(path: string, organizationId: string | undefined): string {
  return organizationId ? `${path}?${new URLSearchParams({ organizationId })}` : path;
}

export function customRoutersEndpoint(organizationId: string | undefined): string {
  return withOrganization(AUTO_ROUTING_CUSTOM_ROUTERS_PATH, organizationId);
}

export function customRouterItemEndpoint(
  scope: CustomRouterScope,
  slug: string,
  organizationId: string | undefined
): string {
  return withOrganization(customRouterPath(scope, slug), organizationId);
}

export function entryLabel(entry: CustomRouterEntryRef): string {
  return entry.kind === 'gateway' ? entry.model : `${entry.provider}/${entry.model}`;
}

async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = CustomRouterErrorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error.message : `Request failed (HTTP ${response.status})`;
}

/** Null when custom routers are not enabled for this owner: the API answers 404. */
export async function fetchCustomRouters(
  organizationId: string | undefined
): Promise<CustomRouterListResponse | null> {
  const response = await fetch(customRoutersEndpoint(organizationId));
  if (response.status === 404) return null;
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
  const response = await fetch(customRouterItemEndpoint(router.scope, router.slug, organizationId), {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export type EntryDisplayStatus = {
  kind: 'ready' | 'stale' | 'pending' | 'failed' | 'needs_eval' | 'missing' | 'unknown';
  label: string;
  detail: string | null;
};

export function entryDisplayStatus(entry: CustomRouterListEntry): EntryDisplayStatus {
  const { variants } = entry;
  if (variants.length === 0) {
    return { kind: 'unknown', label: 'Status unavailable', detail: null };
  }
  const failed = variants.find(variant => variant.status === 'failed');
  if (failed) {
    return { kind: 'failed', label: 'Failed', detail: failed.failureReason };
  }
  if (variants.some(variant => variant.status === 'pending' || variant.status === 'running')) {
    return {
      kind: 'pending',
      label: entry.entry.kind === 'client' ? 'Evaluating' : 'Benchmarking',
      detail: null,
    };
  }
  if (entry.needsClientEval) {
    return {
      kind: 'needs_eval',
      label: 'Needs client eval',
      detail: 'Run the client eval from the CLI to measure this model.',
    };
  }
  if (variants.some(variant => variant.status === 'missing')) {
    return { kind: 'missing', label: 'Not benchmarked yet', detail: null };
  }
  if (variants.some(variant => variant.status === 'stale')) {
    return {
      kind: 'stale',
      label: 'Stale',
      detail: 'Measured with an older benchmark. Routing still uses it.',
    };
  }
  return { kind: 'ready', label: 'Ready', detail: null };
}

export function hasPendingEntries(routers: CustomRouterSummary[]): boolean {
  return routers.some(router =>
    router.entries.some(entry =>
      entry.variants.some(variant => variant.status === 'pending' || variant.status === 'running')
    )
  );
}
