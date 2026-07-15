import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

/**
 * Exact fence the server module uses to route a control command to a specific
 * runtime. `runtimeId` identifies the `kilo remote` process; `connectionId` is
 * opaque relay routing metadata owned by the session-ingest DO. The mobile
 * client never composes fences — it lifts them directly from a `LocalRuntime`
 * returned by `localRuntimeControl.list`.
 */
export type LocalRuntimeFence = {
  runtimeId: string;
  connectionId: string;
};

export type LocalRuntimeCatalogAgent = {
  slug: string;
  name: string;
  description?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
};

/**
 * Mobile-facing projection of a single remote-catalog model. The slice only
 * reads `id` (for selection) and `variants` (for the thinking-effort picker);
 * the full `RemoteModelCatalogV1` carries more metadata (capabilities, limits,
 * provider metadata) that lives in the shared package and is mirrored
 * verbatim through the tRPC `getCatalog` output.
 */
export type LocalRuntimeCatalogModel = {
  id: string;
  name?: string;
  recommendedIndex?: number;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  variants: string[];
};

export type LocalRuntimeCatalogProvider = {
  id: string;
  name?: string;
  models: LocalRuntimeCatalogModel[];
};

/**
 * Mobile-side projection of the catalog. The wire model is the canonical
 * `RemoteModelCatalogV1` (transformed in the web client) — this projection
 * exists so the mobile state helpers can be unit-tested without depending on
 * the web-only `cloud-agent-sdk` import graph.
 */
export type LocalRuntimeCatalogModels = {
  protocolVersion: 1;
  providers: LocalRuntimeCatalogProvider[];
  defaultModel?: { providerID: string; modelID: string };
  truncated: boolean;
};

export type LocalRuntimeCatalog = {
  protocolVersion: 1;
  models: LocalRuntimeCatalogModels;
  agents: LocalRuntimeCatalogAgent[];
  defaultAgent: string;
};

/**
 * Discriminated view-model for the local-session configuration screen. The
 * renderer picks exactly one branch — there is no path where happy and empty
 * compose, and there is no path where retryable and non-retryable compose.
 */
export type LocalSessionConfigViewModel =
  | { kind: 'loading' }
  | { kind: 'empty'; title: string; message: string; retry: () => void }
  | { kind: 'incapable' }
  | {
      kind: 'selecting-runtime';
      runtimes: LocalRuntime[];
      currentFence: LocalRuntimeFence | null;
      onSelect: (fence: LocalRuntimeFence) => void;
      onRefresh: () => void;
    }
  | { kind: 'catalog-loading'; runtime: LocalRuntime; onCancel: () => void }
  | {
      kind: 'catalog-error-retryable';
      runtime: LocalRuntime;
      title: string;
      message: string;
      retry: () => void;
      onChangeRuntime: () => void;
    }
  | {
      kind: 'catalog-error-non-retryable';
      runtime: LocalRuntime;
      title: string;
      message: string;
    }
  | {
      kind: 'ready';
      runtime: LocalRuntime;
      catalog: LocalRuntimeCatalog;
      catalogGeneration: object;
      selectedAgent: LocalRuntimeCatalogAgent;
      selectedModel: { providerID: string; modelID: string };
      selectedVariant: string;
      isModelLocked: boolean;
      onSelectAgent: (slug: string) => void;
      onSelectModel: (selection: { providerID: string; modelID: string; variant: string }) => void;
      onChangeRuntime: () => void;
    };

/**
 * State shape consumed by the local-session configuration view-model. The
 * catalog slice mirrors the four exclusive states a `useQuery` can be in for
 * a fence-anchored query — `idle` (no fence set, the query is disabled),
 * `loading`, `error`, and `ready`. The renderer picks exactly one of these
 * for the catalog and never composes it with the runtimes slice by hand.
 */
export type LocalRuntimeCatalogState =
  | { kind: 'idle' }
  | { kind: 'loading'; runtime: LocalRuntime }
  | {
      kind: 'error';
      runtime: LocalRuntime;
      error: unknown;
      refetch: () => void;
    }
  | {
      kind: 'ready';
      runtime: LocalRuntime;
      catalog: LocalRuntimeCatalog;
      catalogGeneration: object;
    };

export type LocalRuntimesState = {
  data: { runtimes: LocalRuntime[] } | undefined;
  isError: boolean;
  refetch: () => void;
};

export type BuildLocalSessionConfigViewModelInput = {
  runtimesState: LocalRuntimesState;
  selectedFence: LocalRuntimeFence | null;
  onSelectFence: (fence: LocalRuntimeFence) => void;
  onClearFence: () => void;
  catalogState: LocalRuntimeCatalogState;
};
