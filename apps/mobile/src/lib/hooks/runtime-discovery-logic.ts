import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

/**
 * Bounded local runtime presence as returned by the `localRuntimeControl.list`
 * tRPC query. The shape is derived from the shared tRPC router output so the
 * mobile client never duplicates a server-side contract and inherits any
 * future Zod-validated changes.
 */
export type LocalRuntime =
  inferRouterOutputs<RootRouter>['localRuntimeControl']['list']['runtimes'][number];

const REQUIRED_RUNTIME_CAPABILITIES = ['catalog.v1', 'create-and-run.v1'] as const;
type LocalRuntimeCapability = LocalRuntime['capabilities'][number];

/**
 * A runtime is "capable" when it advertises every required capability.
 * Capability order is irrelevant — the contract is a set, not a sequence.
 */
export function hasRequiredRuntimeCapabilities(
  capabilities: readonly LocalRuntimeCapability[]
): boolean {
  if (capabilities.length < REQUIRED_RUNTIME_CAPABILITIES.length) {
    return false;
  }
  const have = new Set(capabilities);
  return REQUIRED_RUNTIME_CAPABILITIES.every(c => have.has(c));
}

export type RuntimeDiscoveryRow =
  | {
      kind: 'capable';
      runtime: LocalRuntime;
      displayName: string;
      projectName: string;
      cliVersion: string;
    }
  | {
      kind: 'incapable';
      runtime: LocalRuntime;
      displayName: string;
      projectName: string;
      cliVersion: string;
    };

/**
 * Project a list of runtimes into the discriminated view-model rows the
 * runtime-discovery screen renders. Every input runtime is projected to a row
 * — an empty list stays empty; we never let an error path collapse a
 * successful response into "no runtimes".
 */
export function buildRuntimeDiscoveryRows(
  runtimes: readonly LocalRuntime[]
): RuntimeDiscoveryRow[] {
  return runtimes.map(runtime => {
    const row = {
      runtime,
      displayName: runtime.displayName,
      projectName: runtime.projectName,
      cliVersion: runtime.cliVersion,
    } as const;
    return hasRequiredRuntimeCapabilities(runtime.capabilities)
      ? { kind: 'capable', ...row }
      : { kind: 'incapable', ...row };
  });
}

/**
 * The four exclusive states a runtime-discovery screen can be in. The
 * view-model collapses React Query's `(data, isLoading, isError)` triple into
 * exactly one of these so the renderer never has to combine them by hand.
 *
 * - `loading`: no cached data yet. No CTA, no error/empty copy.
 * - `error`: an initial load failed. Shows the retryable error CTA; never
 *   collapses into the empty state.
 * - `empty`: a successful list came back with zero runtimes. Shows the
 *   recovery CTA so the user can re-fetch.
 * - `ready`: at least one runtime. The renderer owns the capable/incapable
 *   split via the per-row `kind` discriminator.
 */
export type RuntimeDiscoveryViewModel =
  | { kind: 'loading' }
  | {
      kind: 'error';
      title: string;
      message: string;
      retry: () => void;
    }
  | {
      kind: 'empty';
      title: string;
      message: string;
      retry: () => void;
    }
  | {
      kind: 'ready';
      rows: RuntimeDiscoveryRow[];
      onSelect: (runtime: LocalRuntime) => void;
    };

const LOADING_VIEW_MODEL: RuntimeDiscoveryViewModel = { kind: 'loading' };

const ERROR_TITLE = "Couldn't load local runtimes";
const ERROR_MESSAGE = 'Check your connection and try again.';
const EMPTY_TITLE = 'No local runtimes';
const EMPTY_MESSAGE = 'Run kilo remote in a project, then retry.';
const INCAPABLE_DESCRIPTION = 'Update Kilo CLI and reconnect.';

type BuildRuntimeDiscoveryViewModelInput = {
  data: { runtimes: LocalRuntime[] } | undefined;
  isError: boolean;
  refetch: () => void;
  onSelect?: (runtime: LocalRuntime) => void;
};

export function buildRuntimeDiscoveryViewModel(
  input: BuildRuntimeDiscoveryViewModelInput
): RuntimeDiscoveryViewModel {
  const { data, isError, refetch, onSelect } = input;
  // Cached data always wins over a background error — we never let a stale
  // refetch failure turn a successful list into the empty or error state.
  if (data !== undefined) {
    const rows = buildRuntimeDiscoveryRows(data.runtimes);
    if (rows.length === 0) {
      return {
        kind: 'empty',
        title: EMPTY_TITLE,
        message: EMPTY_MESSAGE,
        retry: refetch,
      };
    }
    return {
      kind: 'ready',
      rows,
      onSelect: runtime => {
        if (!onSelect) {
          return;
        }
        onSelect(runtime);
      },
    };
  }
  if (isError) {
    return {
      kind: 'error',
      title: ERROR_TITLE,
      message: ERROR_MESSAGE,
      retry: refetch,
    };
  }
  return LOADING_VIEW_MODEL;
}

export const RUNTIME_DISCOVERY_COPY = {
  empty: { title: EMPTY_TITLE, message: EMPTY_MESSAGE },
  error: { title: ERROR_TITLE, message: ERROR_MESSAGE },
  incapable: INCAPABLE_DESCRIPTION,
} as const;
