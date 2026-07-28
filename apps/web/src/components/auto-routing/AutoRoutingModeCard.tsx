'use client';

import {
  AutoRoutingModeSchema,
  isVirtualAutoModelId,
  MAX_POOL_ENTRIES,
  poolEntryKey,
  type AutoRoutingMode,
  type BenchmarkProfileEntryStatus,
  type BenchmarkProfileQuotaError,
  type PoolEntry,
} from '@kilocode/auto-routing-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Route, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { thinkingEffortLabel } from '@/lib/code-reviews/core/model-variants';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { DIRECT_BYOK_PROVIDERS_META } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types (mirror the web settings API response; client-safe, no server-only import)
// ---------------------------------------------------------------------------

export type PoolEntryWithAvailability = PoolEntry & {
  unavailable: boolean;
};

export type AutoRoutingSettingsApiResponse = {
  ownerType: 'user' | 'org';
  ownerId: string;
  mode: AutoRoutingMode;
  configuredMode: AutoRoutingMode | null;
  defaultMode: AutoRoutingMode;
  configuredPool: PoolEntryWithAvailability[] | null;
  poolStatuses: BenchmarkProfileEntryStatus[];
};

export type ModeSelection = AutoRoutingMode | 'inherit';

export type DraftPool = PoolEntry[] | null;

export type PoolEntryDisplayStatus =
  | { kind: 'ready'; label: 'Ready' }
  | { kind: 'benchmarking'; label: 'Benchmarking' }
  | { kind: 'failed'; label: 'Failed'; failureReason: string | null }
  | { kind: 'unavailable'; label: 'Unavailable'; explanation: string }
  | { kind: 'not_saved'; label: 'Not saved' };

export const NOT_SAVED_ENTRY_LABEL = 'Not saved' as const;

type Props = {
  organizationId?: string;
  readonly?: boolean;
};

// ---------------------------------------------------------------------------
// Copy (exact strings from plan task 5.3)
// ---------------------------------------------------------------------------

export const PERSONAL_EMPTY_POOL_COPY = 'No custom pool. Efficient uses the platform model pool.';

export const ORGANIZATION_EMPTY_POOL_COPY =
  'No organization override. Members use their personal pool, or the platform model pool if they have none.';

export const UNAVAILABLE_ENTRY_EXPLANATION =
  'This model or variant is no longer available in your catalog and cannot be used for routing.';

export const SETTINGS_POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for focused component tests)
// ---------------------------------------------------------------------------

export function settingsEndpoint(organizationId: string | undefined): string {
  if (!organizationId) return '/api/auto-routing/settings';
  const params = new URLSearchParams({ organizationId });
  return `/api/auto-routing/settings?${params}`;
}

export function settingsQueryKey(organizationId: string | undefined) {
  return ['auto-routing-settings', organizationId ?? 'personal'] as const;
}

export function emptyPoolCopy(organizationId: string | undefined): string {
  return organizationId ? ORGANIZATION_EMPTY_POOL_COPY : PERSONAL_EMPTY_POOL_COPY;
}

export function unsetModeOption(organizationId: string | undefined) {
  return organizationId
    ? {
        value: 'inherit' as const,
        label: 'No organization override',
        description: "Uses the member's personal setting, then the default.",
      }
    : {
        value: 'inherit' as const,
        label: 'Use default setting',
        description: 'Uses best accuracy per dollar.',
      };
}

const modeOptions: Array<{ value: AutoRoutingMode; label: string; description: string }> = [
  {
    value: 'cost_per_accuracy',
    label: 'Best accuracy per dollar',
    description:
      'Chooses the model that passes the accuracy threshold and delivers the best accuracy per dollar.',
  },
  {
    value: 'best_accuracy',
    label: 'Best accuracy',
    description: 'Chooses the highest-accuracy model in the efficient model pool.',
  },
];

export function findStatusForEntry(
  entry: PoolEntry,
  poolStatuses: BenchmarkProfileEntryStatus[]
): BenchmarkProfileEntryStatus | undefined {
  const key = poolEntryKey(entry);
  return poolStatuses.find(status => poolEntryKey(status.entry) === key);
}

export function mapPoolEntryDisplayStatus(params: {
  entry: PoolEntry;
  unavailable?: boolean;
  poolStatuses: BenchmarkProfileEntryStatus[];
  /** When false, the pair exists only in the local draft and has no saved status. */
  isSaved?: boolean;
}): PoolEntryDisplayStatus {
  if (params.isSaved === false) {
    return { kind: 'not_saved', label: NOT_SAVED_ENTRY_LABEL };
  }

  if (params.unavailable) {
    return {
      kind: 'unavailable',
      label: 'Unavailable',
      explanation: UNAVAILABLE_ENTRY_EXPLANATION,
    };
  }

  const status = findStatusForEntry(params.entry, params.poolStatuses);
  if (!status || status.status === 'pending' || status.status === 'running') {
    return { kind: 'benchmarking', label: 'Benchmarking' };
  }
  if (status.status === 'failed') {
    return {
      kind: 'failed',
      label: 'Failed',
      failureReason: status.failureReason ?? null,
    };
  }
  return { kind: 'ready', label: 'Ready' };
}

/**
 * True when the draft differs from the last server snapshot (mode and/or pool).
 * Used so polls/refetches do not clobber unsaved edits or an active save error.
 */
export function isDraftDirty(params: {
  selectedMode: ModeSelection;
  draftPool: DraftPool;
  savedMode: ModeSelection;
  savedPool: DraftPool;
}): boolean {
  return (
    params.selectedMode !== params.savedMode || !draftsEqual(params.draftPool, params.savedPool)
  );
}

/**
 * Override-over-saved draft resolution the card uses on every render.
 * `undefined` overrides mean "follow the latest server snapshot", so polls
 * update statuses/saved pool without clobbering unsaved edits.
 */
export function resolveEffectiveDraft(params: {
  savedMode: ModeSelection;
  savedPool: DraftPool;
  modeOverride: ModeSelection | undefined;
  poolOverride: DraftPool | undefined;
}): { selectedMode: ModeSelection; draftPool: DraftPool } {
  return {
    selectedMode: params.modeOverride ?? params.savedMode,
    draftPool: params.poolOverride !== undefined ? params.poolOverride : params.savedPool,
  };
}

/** Clear pool is offered only when a saved configured pool exists (not draft-only). */
export function shouldShowClearPoolControl(hasConfiguredPool: boolean): boolean {
  return hasConfiguredPool;
}

/**
 * Edit-action visibility for the card chrome and pool rows.
 * Members (`readonly`) never see Save / Add / Remove / Retry / Clear.
 */
export function resolveEditableChrome(params: {
  readonly: boolean;
  hasConfiguredPool: boolean;
  hasSaveError: boolean;
}): {
  showClearPool: boolean;
  showAddModel: boolean;
  showSave: boolean;
  showSaveErrorRetry: boolean;
  showRemove: boolean;
  showRetryBenchmarkForFailed: boolean;
} {
  const editable = !params.readonly;
  return {
    showClearPool: editable && shouldShowClearPoolControl(params.hasConfiguredPool),
    showAddModel: editable,
    showSave: editable,
    showSaveErrorRetry: editable && params.hasSaveError,
    showRemove: editable,
    showRetryBenchmarkForFailed: editable,
  };
}

/** True when any saved (non-unavailable) entry is still pending/running. */
export function hasBenchmarkingEntries(
  configuredPool: PoolEntryWithAvailability[] | null,
  poolStatuses: BenchmarkProfileEntryStatus[]
): boolean {
  if (!configuredPool || configuredPool.length === 0) return false;
  return configuredPool.some(entry => {
    if (entry.unavailable) return false;
    const display = mapPoolEntryDisplayStatus({
      entry,
      unavailable: entry.unavailable,
      poolStatuses,
    });
    return display.kind === 'benchmarking';
  });
}

/**
 * React Query refetchInterval: poll while any saved entry is Benchmarking;
 * stop once every entry is terminal (ready/failed) or unavailable.
 */
export function settingsRefetchInterval(
  data: AutoRoutingSettingsApiResponse | undefined
): number | false {
  if (!data) return false;
  return hasBenchmarkingEntries(data.configuredPool, data.poolStatuses)
    ? SETTINGS_POLL_INTERVAL_MS
    : false;
}

export function draftsEqual(a: DraftPool, b: DraftPool): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && poolEntryKey(entry) === poolEntryKey(other);
  });
}

export function buildSaveBody(params: { mode: ModeSelection; pool: DraftPool }): {
  mode: AutoRoutingMode | null;
  pool: PoolEntry[] | null;
} {
  return {
    mode: params.mode === 'inherit' ? null : params.mode,
    pool: params.pool,
  };
}

export function buildRetryBody(params: {
  mode: ModeSelection;
  savedPool: PoolEntry[];
  retryEntry: PoolEntry;
}): { mode: AutoRoutingMode | null; pool: PoolEntry[]; retryEntries: PoolEntry[] } {
  return {
    mode: params.mode === 'inherit' ? null : params.mode,
    pool: params.savedPool,
    retryEntries: [params.retryEntry],
  };
}

export type AddPoolEntryResult =
  | { ok: true; pool: PoolEntry[] }
  | {
      ok: false;
      reason: 'duplicate' | 'missing_variant' | 'pool_full' | 'no_model';
      message: string;
    };

export function tryAddPoolEntry(params: {
  draftPool: DraftPool;
  modelId: string | undefined;
  variant: string | null | undefined;
  modelVariants: string[] | undefined;
}): AddPoolEntryResult {
  const modelId = params.modelId?.trim();
  if (!modelId) {
    return { ok: false, reason: 'no_model', message: 'Choose a model to add.' };
  }

  const hasVariants = (params.modelVariants?.length ?? 0) > 0;
  const variant =
    params.variant === undefined || params.variant === null || params.variant === ''
      ? null
      : params.variant;

  if (hasVariants && variant === null) {
    return {
      ok: false,
      reason: 'missing_variant',
      message: 'Choose a variant for this model.',
    };
  }
  if (!hasVariants && variant !== null) {
    // Models without variants always store null.
  }

  const entry: PoolEntry = {
    model: modelId,
    variant: hasVariants ? variant : null,
  };

  const current = params.draftPool ?? [];
  if (current.length >= MAX_POOL_ENTRIES) {
    return {
      ok: false,
      reason: 'pool_full',
      message: `An Efficient pool can include at most ${MAX_POOL_ENTRIES} models.`,
    };
  }

  const key = poolEntryKey(entry);
  if (current.some(existing => poolEntryKey(existing) === key)) {
    return {
      ok: false,
      reason: 'duplicate',
      message: 'That model and variant pair is already in the pool.',
    };
  }

  return { ok: true, pool: [...current, entry] };
}

export function removePoolEntry(draftPool: DraftPool, entry: PoolEntry): DraftPool {
  if (!draftPool) return draftPool;
  const key = poolEntryKey(entry);
  const next = draftPool.filter(existing => poolEntryKey(existing) !== key);
  return next.length === 0 ? null : next;
}

const DIRECT_BYOK_PROVIDER_PREFIXES = new Set(
  Object.keys(DIRECT_BYOK_PROVIDERS_META).map(id => `${id}/`)
);

/**
 * Direct-BYOK-only catalog entries use a direct-BYOK provider id prefix
 * (`chutes-byok/…`, `kimi-coding/…`, …) and are always marked
 * `hasUserByokAvailable: true` in the selector list. Managed OpenRouter models
 * may also carry `hasUserByokAvailable` when the user has a matching key — those
 * stay eligible. Server revalidates regardless.
 */
export function isDirectByokOnlyModel(model: {
  id: string;
  hasUserByokAvailable?: boolean;
}): boolean {
  if (model.hasUserByokAvailable !== true) return false;
  const slash = model.id.indexOf('/');
  if (slash <= 0) return false;
  const prefix = model.id.slice(0, slash + 1);
  return DIRECT_BYOK_PROVIDER_PREFIXES.has(prefix);
}

/**
 * Experiment public ids appear in the selector list with ordinary partner ids
 * (not `experiment/…`). `listAvailableExperimentModels` always sets zero
 * pricing and omits `isFree`; managed free models set `isFree: true`. Combined
 * with zero prompt pricing this is the client-visible experiment signal.
 * Server remains authoritative.
 */
export function isExperimentSelectorModel(model: {
  id: string;
  isFree?: boolean;
  pricing?: { prompt?: string } | null;
}): boolean {
  const id = model.id;
  if (!id) return false;
  if (id.includes('/experiment') || id.startsWith('experiment/')) return true;
  if (model.isFree === true) return false;
  const prompt = model.pricing?.prompt;
  if (typeof prompt !== 'string') return false;
  const amount = Number.parseFloat(prompt);
  return Number.isFinite(amount) && amount === 0;
}

/** Client-side usability filter; server revalidates on save. */
export function isEligiblePoolModel(model: {
  id: string;
  name?: string;
  isFree?: boolean;
  hasUserByokAvailable?: boolean;
  pricing?: { prompt?: string } | null;
}): boolean {
  const id = model.id;
  if (!id) return false;
  if (isVirtualAutoModelId(id)) return false;
  if (id.startsWith(CUSTOM_LLM_PREFIX)) return false;
  if (isDirectByokOnlyModel(model)) return false;
  if (isExperimentSelectorModel(model)) return false;
  return true;
}

export type SelectorListModel = {
  id: string;
  name: string;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  pricing?: { prompt?: string } | null;
  opencode?: { variants?: Record<string, unknown> } | null;
};

export function toEligibleModelOptions(
  models: SelectorListModel[],
  draftPool: DraftPool
): ModelOption[] {
  const draftKeys = new Set((draftPool ?? []).map(poolEntryKey));
  return models
    .filter(model => isEligiblePoolModel(model))
    .map(model => {
      const variantKeys = model.opencode?.variants
        ? Object.keys(model.opencode.variants).filter(key => key.trim().length > 0)
        : [];
      return {
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        variants: variantKeys.length > 0 ? variantKeys : undefined,
      };
    })
    .filter(model => {
      // Keep models that still have at least one (model, variant) pair not in the draft.
      // Models with no variants are excluded only when the null-variant pair is already drafted.
      if (!model.variants || model.variants.length === 0) {
        return !draftKeys.has(poolEntryKey({ model: model.id, variant: null }));
      }
      return model.variants.some(
        variant => !draftKeys.has(poolEntryKey({ model: model.id, variant }))
      );
    });
}

export function formatSaveErrorMessage(body: unknown, status: number): string {
  if (status === 429) {
    const retryAt =
      body && typeof body === 'object' && 'retryAt' in body && typeof body.retryAt === 'string'
        ? body.retryAt
        : null;
    const base =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'Benchmark request limit reached.';
    if (retryAt) {
      const when = formatRetryAt(retryAt);
      return `${base} New benchmarks can be requested ${when}.`;
    }
    return base;
  }

  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return 'Failed to save auto routing settings';
}

export function formatRetryAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return `after ${iso}`;
  return `after ${date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

export function formatLoadErrorMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return 'Failed to load auto routing settings';
}

export function variantLabel(variant: string | null): string {
  if (variant === null) return 'Default';
  return thinkingEffortLabel(variant);
}

/**
 * Save mutation `onSuccess` side effects the card wires into `useMutation`.
 * Keeps the committed response in the query cache and clears the save-error panel.
 */
export function applySaveMutationSuccess(params: {
  queryClient: { setQueryData: (key: readonly unknown[], data: unknown) => void };
  queryKey: readonly unknown[];
  data: AutoRoutingSettingsApiResponse;
  setSaveError: (message: string | null) => void;
  setRetryingKey: (key: string | null) => void;
  markClearOverridesAfterSave: () => void;
  setModeOverride: (mode: ModeSelection) => void;
  setPoolOverride: (pool: DraftPool) => void;
  toastSuccess: (message: string) => void;
}): void {
  params.queryClient.setQueryData(params.queryKey, params.data);
  params.setSaveError(null);
  params.setRetryingKey(null);
  params.markClearOverridesAfterSave();
  params.setModeOverride(params.data.configuredMode ?? 'inherit');
  params.setPoolOverride(savedPoolSnapshot(params.data.configuredPool));
  params.toastSuccess('Auto routing settings saved');
}

/**
 * Save mutation `onError` side effects: surface the message for the inline
 * Try again panel and toast (draft overrides are intentionally left alone).
 */
export function applySaveMutationError(params: {
  error: unknown;
  setRetryingKey: (key: string | null) => void;
  setSaveError: (message: string) => void;
  toastError: (message: string) => void;
}): void {
  params.setRetryingKey(null);
  const message =
    params.error instanceof Error ? params.error.message : 'Failed to save auto routing settings';
  params.setSaveError(message);
  params.toastError(message);
}

/**
 * Retry-benchmark mutation `onSuccess`: cache the response and invalidate so
 * polling/status refresh picks up the re-queued profile immediately.
 */
export function applyRetryMutationSuccess(params: {
  queryClient: {
    setQueryData: (key: readonly unknown[], data: unknown) => void;
    invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
  };
  queryKey: readonly unknown[];
  data: AutoRoutingSettingsApiResponse;
  setRetryingKey: (key: string | null) => void;
  toastSuccess: (message: string) => void;
}): void {
  params.queryClient.setQueryData(params.queryKey, params.data);
  void params.queryClient.invalidateQueries({ queryKey: params.queryKey });
  params.setRetryingKey(null);
  params.toastSuccess('Benchmark retry requested');
}

function savedPoolSnapshot(configuredPool: PoolEntryWithAvailability[] | null): DraftPool {
  if (!configuredPool) return null;
  return configuredPool.map(({ model, variant }) => ({ model, variant }));
}

function availabilityByKey(
  configuredPool: PoolEntryWithAvailability[] | null
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  if (!configuredPool) return map;
  for (const entry of configuredPool) {
    map.set(poolEntryKey(entry), entry.unavailable);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Fetch / mutate
// ---------------------------------------------------------------------------

async function fetchSettings(
  organizationId: string | undefined
): Promise<AutoRoutingSettingsApiResponse> {
  const response = await fetch(settingsEndpoint(organizationId));
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(formatLoadErrorMessage(body));
  }
  return body as AutoRoutingSettingsApiResponse;
}

async function putSettings(
  organizationId: string | undefined,
  payload: {
    mode: AutoRoutingMode | null;
    pool: PoolEntry[] | null;
    retryEntries?: PoolEntry[];
  }
): Promise<AutoRoutingSettingsApiResponse> {
  const response = await fetch(settingsEndpoint(organizationId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = formatSaveErrorMessage(body, response.status);
    const error = new Error(message) as Error & {
      status?: number;
      retryAt?: string;
      quota?: BenchmarkProfileQuotaError;
    };
    error.status = response.status;
    if (body && typeof body === 'object' && 'retryAt' in body && typeof body.retryAt === 'string') {
      error.retryAt = body.retryAt;
    }
    throw error;
  }
  return body as AutoRoutingSettingsApiResponse;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AutoRoutingModeCard({ organizationId, readonly = false }: Props) {
  const queryClient = useQueryClient();
  const queryKey = settingsQueryKey(organizationId);
  const idPrefix = useId();
  const modeFieldId = `${idPrefix}-mode`;
  const modeHelpId = `${idPrefix}-mode-help`;
  const poolHelpId = `${idPrefix}-pool-help`;
  const addErrorId = `${idPrefix}-add-error`;
  const loadErrorId = `${idPrefix}-load-error`;
  const saveErrorId = `${idPrefix}-save-error`;
  const addModelSectionRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchSettings(organizationId),
    refetchInterval: query => settingsRefetchInterval(query.state.data),
    refetchOnWindowFocus: true,
  });

  const modelsQuery = useModelSelectorList(organizationId);

  // Local draft overrides. `undefined` means "follow the latest server snapshot".
  // Polls/refetches update statuses via query.data without touching these.
  const [modeOverride, setModeOverride] = useState<ModeSelection | undefined>(undefined);
  const [poolOverride, setPoolOverride] = useState<DraftPool | undefined>(undefined);
  const [addModelId, setAddModelId] = useState<string | undefined>(undefined);
  const [addVariant, setAddVariant] = useState<string | undefined>(undefined);
  const [addError, setAddError] = useState<string | null>(null);
  const [showAddFlow, setShowAddFlow] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  // After a successful save, drop overrides once the query reflects the new snapshot.
  const clearOverridesAfterSaveRef = useRef(false);

  const savedMode: ModeSelection = query.data?.configuredMode ?? 'inherit';
  const savedPool = useMemo(
    () => savedPoolSnapshot(query.data?.configuredPool ?? null),
    [query.data?.configuredPool]
  );
  const availabilityMap = useMemo(
    () => availabilityByKey(query.data?.configuredPool ?? null),
    [query.data?.configuredPool]
  );
  const poolStatuses = query.data?.poolStatuses ?? [];

  const { selectedMode, draftPool } = resolveEffectiveDraft({
    savedMode,
    savedPool,
    modeOverride,
    poolOverride,
  });

  useEffect(() => {
    if (!clearOverridesAfterSaveRef.current) return;
    if (!query.data) return;
    // Drop local overrides so the draft tracks the post-save server snapshot
    // (and subsequent clean polls). Do not clear while a later edit is dirty.
    const nextSavedMode: ModeSelection = query.data.configuredMode ?? 'inherit';
    const nextSavedPool = savedPoolSnapshot(query.data.configuredPool);
    const stillDirty =
      (modeOverride !== undefined && modeOverride !== nextSavedMode) ||
      (poolOverride !== undefined && !draftsEqual(poolOverride, nextSavedPool));
    if (stillDirty) return;
    clearOverridesAfterSaveRef.current = false;
    setModeOverride(undefined);
    setPoolOverride(undefined);
  }, [query.data, modeOverride, poolOverride]);

  const saveMutation = useMutation({
    mutationFn: (payload: {
      mode: AutoRoutingMode | null;
      pool: PoolEntry[] | null;
      retryEntries?: PoolEntry[];
    }) => putSettings(organizationId, payload),
    onSuccess: data => {
      // Align overrides with the saved response immediately so the UI shows
      // the committed pool; the effect above clears them once query.data matches.
      applySaveMutationSuccess({
        queryClient,
        queryKey,
        data,
        setSaveError,
        setRetryingKey,
        markClearOverridesAfterSave: () => {
          clearOverridesAfterSaveRef.current = true;
        },
        setModeOverride,
        setPoolOverride,
        toastSuccess: message => toast.success(message),
      });
    },
    onError: error => {
      applySaveMutationError({
        error,
        setRetryingKey,
        setSaveError,
        toastError: message => toast.error(message),
      });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (payload: {
      mode: AutoRoutingMode | null;
      pool: PoolEntry[];
      retryEntries: PoolEntry[];
    }) => putSettings(organizationId, payload),
    onSuccess: data => {
      applyRetryMutationSuccess({
        queryClient,
        queryKey,
        data,
        setRetryingKey,
        toastSuccess: message => toast.success(message),
      });
    },
    onError: error => {
      setRetryingKey(null);
      const message = error instanceof Error ? error.message : 'Failed to retry benchmark';
      toast.error(message);
    },
  });

  const eligibleModels = useMemo(
    () => toEligibleModelOptions(modelsQuery.data?.data ?? [], draftPool),
    [modelsQuery.data?.data, draftPool]
  );

  const selectedAddModel = eligibleModels.find(model => model.id === addModelId);
  const addModelVariants = selectedAddModel?.variants ?? [];

  const resetOption = unsetModeOption(organizationId);
  const selectedOption =
    selectedMode === 'inherit'
      ? resetOption
      : (modeOptions.find(option => option.value === selectedMode) ?? modeOptions[0]);

  const controlsDisabled = readonly || query.isLoading || saveMutation.isPending;
  const hasChanges = isDraftDirty({
    selectedMode,
    draftPool,
    savedMode,
    savedPool,
  });
  const hasConfiguredPool = savedPool !== null && savedPool.length > 0;
  const draftHasEntries = draftPool !== null && draftPool.length > 0;
  const editableChrome = resolveEditableChrome({
    readonly,
    hasConfiguredPool,
    hasSaveError: saveError !== null,
  });
  const focusAddFlow = () => {
    setShowAddFlow(true);
    setAddError(null);
    // Defer focus until the add controls mount.
    requestAnimationFrame(() => {
      addModelSectionRef.current
        ?.querySelector<HTMLElement>('button[role="combobox"], button')
        ?.focus();
    });
  };

  const handleAdd = () => {
    const result = tryAddPoolEntry({
      draftPool,
      modelId: addModelId,
      variant: addVariant,
      modelVariants: addModelVariants,
    });
    if (!result.ok) {
      setAddError(result.message);
      return;
    }
    setPoolOverride(result.pool);
    setAddModelId(undefined);
    setAddVariant(undefined);
    setAddError(null);
    setShowAddFlow(false);
  };

  const handleRemove = (entry: PoolEntry) => {
    setPoolOverride(removePoolEntry(draftPool, entry));
    setAddError(null);
  };

  const handleClearPool = () => {
    setPoolOverride(null);
    setAddError(null);
  };

  const handleSave = () => {
    setSaveError(null);
    saveMutation.mutate(buildSaveBody({ mode: selectedMode, pool: draftPool }));
  };

  const handleRetryBenchmark = (entry: PoolEntry) => {
    if (!savedPool) return;
    setRetryingKey(poolEntryKey(entry));
    retryMutation.mutate(
      buildRetryBody({
        mode: savedMode,
        savedPool,
        retryEntry: entry,
      })
    );
  };

  const poolSectionDescription = emptyPoolCopy(organizationId);

  if (query.isLoading && !query.data) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Route className="size-5" />
            Auto routing
          </CardTitle>
          <CardDescription>
            Choose how Kilo ranks models for kilo-auto/efficient and which models belong in the
            Efficient pool.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4" aria-busy="true">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-9 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (query.isError && !query.data) {
    const message =
      query.error instanceof Error ? query.error.message : formatLoadErrorMessage(null);
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Route className="size-5" />
            Auto routing
          </CardTitle>
          <CardDescription>
            Choose how Kilo ranks models for kilo-auto/efficient and which models belong in the
            Efficient pool.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive" id={loadErrorId}>
            <AlertTitle>Could not load auto routing settings</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
          <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-5" />
          Auto routing
        </CardTitle>
        <CardDescription>
          Choose how Kilo ranks models for kilo-auto/efficient and which models belong in the
          Efficient pool.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor={modeFieldId}>Routing mode</Label>
          <Select
            value={selectedMode}
            onValueChange={value =>
              setModeOverride(value === 'inherit' ? 'inherit' : AutoRoutingModeSchema.parse(value))
            }
            disabled={controlsDisabled}
          >
            <SelectTrigger id={modeFieldId} aria-describedby={modeHelpId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={resetOption.value}>{resetOption.label}</SelectItem>
              {modeOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={modeHelpId} className="text-muted-foreground text-sm">
            {selectedOption.description}
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-medium">Efficient model pool</h3>
              <p id={poolHelpId} className="text-muted-foreground text-sm">
                Up to {MAX_POOL_ENTRIES} exact model and variant pairs. Leave empty to inherit.
              </p>
            </div>
            {editableChrome.showAddModel && (
              <div className="flex flex-wrap gap-2">
                {editableChrome.showClearPool ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={controlsDisabled || draftPool === null}
                    onClick={handleClearPool}
                  >
                    Clear pool
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    controlsDisabled || (draftPool !== null && draftPool.length >= MAX_POOL_ENTRIES)
                  }
                  onClick={focusAddFlow}
                >
                  <Plus className="size-4" aria-hidden />
                  Add model
                </Button>
              </div>
            )}
          </div>

          {!draftHasEntries ? (
            <div
              className="bg-muted/30 space-y-3 rounded-md border border-dashed p-4"
              role="status"
              aria-describedby={poolHelpId}
            >
              <p className="text-muted-foreground text-sm">{poolSectionDescription}</p>
              {editableChrome.showAddModel && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={focusAddFlow}
                >
                  <Plus className="size-4" aria-hidden />
                  Add model
                </Button>
              )}
            </div>
          ) : (
            <ul className="space-y-2" aria-describedby={poolHelpId}>
              {(draftPool ?? []).map(entry => {
                const unavailable = availabilityMap.get(poolEntryKey(entry)) ?? false;
                const isSaved =
                  savedPool?.some(saved => poolEntryKey(saved) === poolEntryKey(entry)) ?? false;
                const display = mapPoolEntryDisplayStatus({
                  entry,
                  unavailable,
                  poolStatuses,
                  isSaved,
                });

                return (
                  <li
                    key={poolEntryKey(entry)}
                    className={cn(
                      'bg-card flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between'
                    )}
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-mono text-sm">{entry.model}</p>
                      <p className="text-muted-foreground text-sm">
                        Variant: {variantLabel(entry.variant)}
                      </p>
                      <p className="text-sm" data-status={display.kind}>
                        <span
                          className={cn(
                            'font-medium',
                            display.kind === 'not_saved' && 'text-muted-foreground'
                          )}
                        >
                          {display.label}
                        </span>
                        {display.kind === 'failed' && display.failureReason ? (
                          <span className="text-muted-foreground mt-0.5 block text-xs">
                            {display.failureReason}
                          </span>
                        ) : null}
                        {display.kind === 'unavailable' ? (
                          <span className="text-muted-foreground mt-0.5 block text-xs">
                            {display.explanation}
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {display.kind === 'failed' &&
                      editableChrome.showRetryBenchmarkForFailed &&
                      isSaved ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            controlsDisabled ||
                            retryMutation.isPending ||
                            retryingKey === poolEntryKey(entry)
                          }
                          onClick={() => handleRetryBenchmark(entry)}
                        >
                          {retryingKey === poolEntryKey(entry) ? 'Retrying…' : 'Retry benchmark'}
                        </Button>
                      ) : null}
                      {editableChrome.showRemove ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          disabled={controlsDisabled}
                          aria-label={`Remove ${entry.model} ${variantLabel(entry.variant)} from pool`}
                          onClick={() => handleRemove(entry)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {showAddFlow && editableChrome.showAddModel ? (
            <div ref={addModelSectionRef} className="bg-muted/20 space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Add model</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Cancel add model"
                  onClick={() => {
                    setShowAddFlow(false);
                    setAddError(null);
                    setAddModelId(undefined);
                    setAddVariant(undefined);
                  }}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <ModelCombobox
                    label="Model"
                    models={eligibleModels}
                    value={addModelId}
                    onValueChange={value => {
                      setAddModelId(value);
                      setAddVariant(undefined);
                      setAddError(null);
                    }}
                    isLoading={modelsQuery.isLoading}
                    disabled={controlsDisabled}
                    required
                    error={addError && !addModelId ? addError : undefined}
                  />
                </div>
                {addModelVariants.length > 0 ? (
                  <div className="space-y-2 sm:w-44">
                    <Label>Variant</Label>
                    <VariantCombobox
                      variants={addModelVariants}
                      value={addVariant}
                      onValueChange={value => {
                        setAddVariant(value);
                        setAddError(null);
                      }}
                      disabled={controlsDisabled || !addModelId}
                      className="w-full"
                    />
                  </div>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  className="sm:mb-0.5"
                  disabled={controlsDisabled || !addModelId}
                  onClick={handleAdd}
                  aria-describedby={addError ? addErrorId : undefined}
                >
                  Add
                </Button>
              </div>
              {addError ? (
                <p id={addErrorId} className="text-destructive text-sm" role="alert">
                  {addError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {saveError ? (
          <Alert variant="destructive" id={saveErrorId}>
            <AlertTitle>Could not save auto routing settings</AlertTitle>
            <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{saveError}</span>
              {editableChrome.showSaveErrorRetry ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={handleSave}
                >
                  Try again
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {editableChrome.showSave && (
          <Button
            type="button"
            onClick={handleSave}
            disabled={controlsDisabled || !hasChanges}
            aria-describedby={saveError ? saveErrorId : undefined}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save auto routing'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
