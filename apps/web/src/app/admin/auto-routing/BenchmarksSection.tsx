'use client';

import {
  BENCHMARK_CONTAINER_BUDGET,
  BENCHMARK_PLATFORM_RESERVED_CONTAINERS,
  DEFAULT_AUTO_ROUTER,
  type AutoRouter,
  BenchmarkConfigResponseSchema,
  BenchmarkRegistryResponseSchema,
  BenchmarkRoutingTableResponseSchema,
  BenchmarkRunsResponseSchema,
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
  getReasoningVariantKeys,
  RequeueBenchmarkRegistryResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkPlatformModel,
  type BenchmarkKind,
  type BenchmarkModelSummary,
  type BenchmarkQueueSelector,
  type BenchmarkRegistryQueue,
  type BenchmarkRegistryResponse,
  type BenchmarkRoutingTableResponse,
  type BenchmarkRun,
  type PolicySettingState,
  type PolicySettingValue,
  resolvePolicySettings,
  type BenchmarkRunProgress,
  type RankedCandidate,
} from '@kilocode/auto-routing-contracts';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Play, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { toEligibleModelOptions } from '@/components/auto-routing/AutoRoutingModeCard';
import { PoolModalityWarning } from '@/components/auto-routing/PoolModalityWarning';
import {
  computePoolModalityCoverage,
  type ModalityCatalogModel,
} from '@/lib/auto-routing-pool-modality';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { parseAdminResponse } from './admin-fetch';
import { useSystemOneModelOptions } from './system-one-models';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function formatAccuracy(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatUsd(n: number | null): string {
  if (n === null) return '—';
  // 6 dp, remove trailing zeros, but keep at least $0.000001 precision
  const fixed = n.toFixed(6);
  // Trim trailing zeros after decimal, but leave at least one digit after dot
  const trimmed = fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return `$${trimmed}`;
}

export function costPerAccuracy(candidate: Pick<RankedCandidate, 'accuracy' | 'avgCostUsd'>) {
  return candidate.accuracy > 0
    ? candidate.avgCostUsd / candidate.accuracy
    : Number.POSITIVE_INFINITY;
}

// Below this share of the expected cases the completion rate is still noise, so
// no finish time is projected from it.
const ETA_MIN_PERCENT = 5;

export type RunProgressDisplay = {
  /** Null when the run's expected total is unknown; render counts without a bar. */
  percent: number | null;
  counts: string;
  eta: string | null;
};

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatRunProgress(
  progress: BenchmarkRunProgress,
  startedAt: string,
  now: number = Date.now()
): RunProgressDisplay {
  const { completedCases, totalCases } = progress;
  const failed = progress.failedCases > 0 ? ` · ${progress.failedCases} failed` : '';
  if (totalCases === null || totalCases <= 0) {
    return { percent: null, counts: `${completedCases} / ? cases${failed}`, eta: null };
  }
  const percent = Math.min(100, (completedCases / totalCases) * 100);
  const startedMs = Date.parse(startedAt);
  const elapsedMs = now - startedMs;
  const remainingCases = totalCases - completedCases;
  const eta =
    completedCases > 0 &&
    remainingCases > 0 &&
    percent >= ETA_MIN_PERCENT &&
    Number.isFinite(startedMs) &&
    elapsedMs > 0
      ? formatDuration((elapsedMs / completedCases) * remainingCases)
      : null;
  return {
    percent,
    counts: `${completedCases} / ${totalCases} cases${failed}`,
    eta,
  };
}

export function formatCostPerAccuracy(candidate: Pick<RankedCandidate, 'accuracy' | 'avgCostUsd'>) {
  const value = costPerAccuracy(candidate);
  return Number.isFinite(value) ? formatUsd(value) : '—';
}

export function formatPolicyValue(value: PolicySettingValue): string {
  if (value === null) return 'off';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  return `${Math.round(value.uncachedInputTokens)} uncached / ${Math.round(value.cachedInputTokens)} cached tokens`;
}

// The four auto settings that accept an admin override, plus the two token
// fields the profile override is entered through.
type PolicyOverrideForm = {
  minAccuracy: string;
  accuracyNoiseBand: string;
  switchHorizonTurns: string;
  uncachedInputTokens: string;
  cachedInputTokens: string;
};

function overrideNumberText(value: PolicySettingValue | undefined): string {
  return typeof value === 'number' ? String(value) : '';
}

function overrideFormFromConfig(config: BenchmarkConfig | null): PolicyOverrideForm {
  const overrides = config?.policyOverrides ?? null;
  const profile = overrides?.productionTokenProfile ?? null;
  return {
    minAccuracy: overrideNumberText(overrides?.minAccuracy),
    accuracyNoiseBand: overrideNumberText(overrides?.accuracyNoiseBand),
    switchHorizonTurns: overrideNumberText(overrides?.switchHorizonTurns),
    uncachedInputTokens:
      profile !== null && typeof profile === 'object' ? String(profile.uncachedInputTokens) : '',
    cachedInputTokens:
      profile !== null && typeof profile === 'object' ? String(profile.cachedInputTokens) : '',
  };
}

function parseBoundedOverride(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function parseTurnOverride(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const turns = Math.round(Number(trimmed));
  return Number.isFinite(turns) && turns >= 1 ? turns : null;
}

export function policyOverridesFromForm(form: PolicyOverrideForm): BenchmarkConfig['policyOverrides'] {
  const overrides: NonNullable<BenchmarkConfig['policyOverrides']> = {};
  const minAccuracy = parseBoundedOverride(form.minAccuracy);
  if (minAccuracy !== null) overrides.minAccuracy = minAccuracy;
  const accuracyNoiseBand = parseBoundedOverride(form.accuracyNoiseBand);
  if (accuracyNoiseBand !== null) overrides.accuracyNoiseBand = accuracyNoiseBand;
  const switchHorizonTurns = parseTurnOverride(form.switchHorizonTurns);
  if (switchHorizonTurns !== null) overrides.switchHorizonTurns = switchHorizonTurns;
  const uncached = parseOptionalNumber(form.uncachedInputTokens);
  const cached = parseOptionalNumber(form.cachedInputTokens);
  if (uncached !== null || cached !== null) {
    overrides.productionTokenProfile = {
      uncachedInputTokens: uncached ?? 0,
      cachedInputTokens: cached ?? 0,
    };
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

// ---------------------------------------------------------------------------
// Model picker helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Pins a saved model id that is absent from the eligible catalog so it stays selectable. */
export function pinnedModelFor(id: string): ModelOption {
  return { id, name: id };
}

export function effortCoverageForModel(
  model: ModelOption | undefined,
  entries?: BenchmarkRegistryResponse['platformEntries']
): string {
  if (model?.reasoningVariants === undefined) return 'Effort coverage unavailable';
  const efforts: (string | null)[] =
    model.reasoningVariants.length > 0 ? model.reasoningVariants : [null];
  const supported =
    model.reasoningVariants.length > 0
      ? `All ${efforts.length} efforts: ${model.reasoningVariants.join(', ')}`
      : 'Default (no configurable effort)';
  if (entries === undefined) return `${supported} · Measurement status unavailable`;
  const statuses = efforts.map(variant => ({
    variant,
    status: entries.find(entry => entry.model === model.id && entry.variant === variant)?.status,
  }));
  const measured = statuses.filter(entry => entry.status === 'ready').length;
  const outstanding = statuses
    .filter(entry => entry.status !== 'ready')
    .map(entry => `${entry.variant ?? 'default'}: ${entry.status ?? 'not measured'}`);
  return `${supported} · ${measured} of ${efforts.length} measured${outstanding.length > 0 ? ` · ${outstanding.join(', ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchBenchmarkConfig(router: AutoRouter) {
  const response = await fetch(`/admin/api/auto-routing/benchmark-config?router=${router}`);
  return parseAdminResponse(response, BenchmarkConfigResponseSchema);
}

async function saveBenchmarkConfig(config: BenchmarkConfig) {
  const response = await fetch('/admin/api/auto-routing/benchmark-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseAdminResponse(response, BenchmarkConfigResponseSchema);
}

/** Run-list filter. Classifier, platform-queue and user-queue runs interleave. */
export type RunFilter = 'all' | 'classifier' | 'platform' | 'user';

const RUN_FILTER_LABELS: Record<RunFilter, string> = {
  all: 'All',
  classifier: 'Classifier',
  platform: 'Platform queue',
  user: 'User queue',
};

export function runFilterQuery(filter: RunFilter): string {
  if (filter === 'classifier') return '?kind=classifier';
  if (filter === 'platform') return '?kind=decider&purpose=platform';
  if (filter === 'user') return '?kind=decider&purpose=user';
  return '';
}

/** Human label for a run row: the three kinds of run are named distinctly. */
export function runTypeLabel(run: Pick<BenchmarkRun, 'kind' | 'purpose'>): string {
  if (run.kind === 'classifier') return 'Classifier';
  return run.purpose === 'user' ? 'User queue' : 'Platform queue';
}

async function fetchBenchmarkRuns(filter: RunFilter, router: AutoRouter) {
  const query = new URLSearchParams(runFilterQuery(filter).replace(/^\?/, ''));
  query.set('router', router);
  const response = await fetch(`/admin/api/auto-routing/benchmark-runs?${query}`);
  return parseAdminResponse(response, BenchmarkRunsResponseSchema);
}

async function startBenchmarkRun({
  kind,
  force,
  queue,
  router,
}: {
  kind: BenchmarkKind;
  force: boolean;
  queue: BenchmarkQueueSelector;
  router: AutoRouter;
}) {
  const response = await fetch('/admin/api/auto-routing/benchmark-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, force, queue, router }),
  });
  return parseAdminResponse(response, StartBenchmarkRunResponseSchema);
}

async function fetchBenchmarkRegistry(router: AutoRouter) {
  const response = await fetch(`/admin/api/auto-routing/benchmark-registry?router=${router}`);
  return parseAdminResponse(response, BenchmarkRegistryResponseSchema);
}

async function requeueBenchmarkRegistry(scope: BenchmarkQueueSelector, router: AutoRouter) {
  const response = await fetch('/admin/api/auto-routing/benchmark-registry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope, router }),
  });
  return parseAdminResponse(response, RequeueBenchmarkRegistryResponseSchema);
}

async function fetchBenchmarkRoutingTable(router: AutoRouter) {
  const response = await fetch(`/admin/api/auto-routing/benchmark-routing-table?router=${router}`);
  return parseAdminResponse<BenchmarkRoutingTableResponse>(
    response,
    BenchmarkRoutingTableResponseSchema
  );
}

// ---------------------------------------------------------------------------
// Local form state type for decider model rows
// ---------------------------------------------------------------------------

type DeciderModelRow = BenchmarkPlatformModel;

function optionalNumberText(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// Both blank clears the profile; a single blank side counts as zero tokens.
function parseTokenProfile(state: {
  uncachedInputTokens: string;
  cachedInputTokens: string;
}): BenchmarkConfig['productionTokenProfile'] {
  const uncachedInputTokens = parseOptionalNumber(state.uncachedInputTokens);
  const cachedInputTokens = parseOptionalNumber(state.cachedInputTokens);
  if (uncachedInputTokens === null && cachedInputTokens === null) return null;
  return {
    uncachedInputTokens: uncachedInputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
  };
}

export type BenchmarkConfigFormState = {
  classifierModels: string[];
  deciderModels: DeciderModelRow[];
  minAccuracy: number;
  accuracyNoiseBand: number;
  frontierMinAccuracyDelta: number;
  switchCostFactor: number;
  bestAccuracySwitchThreshold: number;
  benchmarkUserId: string;
  benchmarkOrgId: string;
  classifierRepetitions: number;
  deciderRepetitions: number;
  classifierMaxP95LatencyMs: string;
  uncachedInputTokens: string;
  cachedInputTokens: string;
  switchHorizonTurns: string;
  lowConfidenceThreshold: string;
  policyOverrides: PolicyOverrideForm;
};

export function configToFormState(config: BenchmarkConfig | null): BenchmarkConfigFormState {
  if (config === null) {
    // No config saved yet: identity fields are overrides, so blank means the
    // worker uses its default benchmark user and org at run time.
    return {
      classifierModels: [],
      deciderModels: [],
      minAccuracy: 0.7,
      accuracyNoiseBand: 0.05,
      frontierMinAccuracyDelta: 0,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      benchmarkUserId: '',
      benchmarkOrgId: '',
      classifierRepetitions: 1,
      deciderRepetitions: 1,
      classifierMaxP95LatencyMs: '1000',
      uncachedInputTokens: '',
      cachedInputTokens: '',
      switchHorizonTurns: '',
      lowConfidenceThreshold: '',
      policyOverrides: overrideFormFromConfig(null),
    };
  }
  return {
    classifierModels: config.classifierModels,
    deciderModels: config.deciderModels.map(({ id }) => ({ id })),
    minAccuracy: config.minAccuracy,
    accuracyNoiseBand: config.accuracyNoiseBand,
    frontierMinAccuracyDelta: config.frontierMinAccuracyDelta,
    switchCostFactor: config.switchCostFactor,
    bestAccuracySwitchThreshold: config.bestAccuracySwitchThreshold,
    benchmarkUserId: config.benchmarkUserId ?? '',
    benchmarkOrgId: config.benchmarkOrgId ?? '',
    classifierRepetitions: config.classifierRepetitions,
    deciderRepetitions: config.deciderRepetitions,
    classifierMaxP95LatencyMs:
      config.classifierMaxP95LatencyMs !== null ? String(config.classifierMaxP95LatencyMs) : '',
    uncachedInputTokens: optionalNumberText(config.productionTokenProfile?.uncachedInputTokens),
    cachedInputTokens: optionalNumberText(config.productionTokenProfile?.cachedInputTokens),
    switchHorizonTurns: optionalNumberText(config.switchHorizonTurns),
    lowConfidenceThreshold: optionalNumberText(config.lowConfidenceThreshold),
    policyOverrides: overrideFormFromConfig(config),
  };
}

export function formStateToConfig(
  state: BenchmarkConfigFormState,
  base: BenchmarkConfig | null
): BenchmarkConfig {
  const classifierModels = state.classifierModels.map(id => id.trim()).filter(id => id.length > 0);
  const deciderModels = state.deciderModels
    .filter(row => row.id.trim().length > 0)
    .map(row => ({ id: row.id.trim() }));
  const benchmarkUserId = state.benchmarkUserId.trim();
  const benchmarkOrgId = state.benchmarkOrgId.trim();
  const rawLatency = state.classifierMaxP95LatencyMs.trim();
  const classifierMaxP95LatencyMs = rawLatency.length > 0 ? parseInt(rawLatency, 10) || null : null;
  return {
    router: base?.router ?? DEFAULT_AUTO_ROUTER,
    classifierModels,
    deciderModels,
    minAccuracy: state.minAccuracy,
    accuracyNoiseBand: state.accuracyNoiseBand,
    frontierMinAccuracyDelta: state.frontierMinAccuracyDelta,
    switchCostFactor: state.switchCostFactor,
    bestAccuracySwitchThreshold: state.bestAccuracySwitchThreshold,
    productionTokenProfile: parseTokenProfile(state),
    switchHorizonTurns: parseOptionalNumber(state.switchHorizonTurns),
    lowConfidenceThreshold: parseOptionalNumber(state.lowConfidenceThreshold),
    benchmarkUserId: benchmarkUserId.length > 0 ? benchmarkUserId : null,
    benchmarkOrgId: benchmarkOrgId.length > 0 ? benchmarkOrgId : null,
    classifierRepetitions: state.classifierRepetitions,
    deciderRepetitions: state.deciderRepetitions,
    classifierMaxP95LatencyMs,
    policyOverrides: policyOverridesFromForm(state.policyOverrides),
    updatedAt: base?.updatedAt ?? null,
    updatedBy: base?.updatedBy ?? null,
  };
}

// ---------------------------------------------------------------------------
// Config editor sub-component
// ---------------------------------------------------------------------------

function ConfigSectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mt-4 flex flex-col gap-0.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-muted-foreground text-xs">{description}</p>
    </div>
  );
}

function formatComputedAt(computedAt: string): string {
  const date = new Date(computedAt);
  return Number.isNaN(date.getTime()) ? computedAt : date.toLocaleString();
}

/**
 * One policy setting on the Policy tab. Auto settings show the effective value,
 * whether it comes from the system or an override, the last computed value and
 * its evidence, and an override input with a reset. Fixed settings are read-only
 * with the reason nobody should change them.
 */
function PolicySettingField({
  state,
  overridden,
  help,
  children,
}: {
  state: PolicySettingState;
  overridden: boolean;
  help?: string;
  children?: React.ReactNode;
}) {
  const computed = state.computed;
  if (state.kind === 'fixed') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{state.label}</span>
          <Badge variant="outline" className="text-[10px]">
            Fixed
          </Badge>
          <span className="text-sm tabular-nums">{formatPolicyValue(state.effective)}</span>
        </div>
        {state.reason ? <p className="text-muted-foreground text-xs">{state.reason}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{state.label}</span>
        <Badge variant={overridden ? 'default' : 'secondary'} className="text-[10px]">
          {overridden ? 'Override' : 'System'}
        </Badge>
        <span className="text-muted-foreground text-xs tabular-nums">
          Effective {formatPolicyValue(state.effective)}
        </span>
      </div>
      {computed ? (
        <>
          <p className="text-muted-foreground text-xs">
            System {formatPolicyValue(computed.value)} · computed {formatComputedAt(computed.computedAt)}{' '}
            · {computed.source}
          </p>
          <p className="text-muted-foreground text-xs">{computed.evidence}</p>
        </>
      ) : (
        <p className="text-muted-foreground text-xs">
          Not computed yet — the current value stands until the daily re-evaluation has data.
        </p>
      )}
      {help ? <p className="text-muted-foreground text-xs">{help}</p> : null}
      {children ? <div className="flex flex-wrap items-end gap-2">{children}</div> : null}
    </div>
  );
}

function UseSystemValueButton({
  overridden,
  onClick,
  label,
}: {
  overridden: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8"
      disabled={!overridden}
      onClick={onClick}
      aria-label={label}
    >
      Use system value
    </Button>
  );
}

function BenchmarkConfigEditor({
  router,
  config,
  onSaved,
  modelOptions,
  modelsLoading,
  modelsError,
  classifierModelOptions,
  classifierModelsLoading,
  classifierModelsError,
  registryEntries,
  catalogModalities,
}: {
  config: BenchmarkConfig | null;
  router: AutoRouter;
  onSaved: (next: { config: BenchmarkConfig | null }) => void;
  modelOptions: ModelOption[];
  modelsLoading: boolean;
  modelsError?: string;
  classifierModelOptions: ModelOption[];
  classifierModelsLoading: boolean;
  classifierModelsError?: string;
  registryEntries?: BenchmarkRegistryResponse['platformEntries'];
  catalogModalities: readonly ModalityCatalogModel[];
}) {
  const [form, setForm] = useState(() => configToFormState(config));
  // Tracks unsaved local edits. A background config refetch (the runs list
  // polls; the query also refetches on focus) must not silently overwrite
  // in-progress edits, so the sync effect only resets the form while pristine.
  const [dirty, setDirty] = useState(false);

  // Any user edit goes through this so it marks the form dirty.
  const updateForm = useCallback(
    (
      updater: (prev: ReturnType<typeof configToFormState>) => ReturnType<typeof configToFormState>
    ) => {
      setForm(updater);
      setDirty(true);
    },
    []
  );

  // Sync from server config only on initial load / after a save — never while
  // the admin has unsaved edits (that would discard their work).
  useEffect(() => {
    if (!dirty) setForm(configToFormState(config));
  }, [config, dirty]);

  // Discard local edits and reload the latest server config (explicit conflict
  // recovery when a remote update arrived while editing).
  const handleReload = useCallback(() => {
    setForm(configToFormState(config));
    setDirty(false);
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: (next: BenchmarkConfig) => saveBenchmarkConfig({ ...next, router }),
    onSuccess: data => {
      // The save is now the source of truth: clear dirty and re-sync so the
      // next background refetch is free to update the form again.
      setForm(configToFormState(data.config));
      setDirty(false);
      onSaved(data);
      toast.success('Benchmark config saved');
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save benchmark config');
    },
  });

  const handleAddClassifierRow = useCallback(() => {
    updateForm(prev => ({
      ...prev,
      classifierModels: [...prev.classifierModels, ''],
    }));
  }, [updateForm]);

  const handleRemoveClassifierRow = useCallback(
    (index: number) => {
      updateForm(prev => ({
        ...prev,
        classifierModels: prev.classifierModels.filter((_, i) => i !== index),
      }));
    },
    [updateForm]
  );

  const handleClassifierModelChange = useCallback(
    (index: number, value: string) => {
      updateForm(prev => ({
        ...prev,
        classifierModels: prev.classifierModels.map((id, i) => (i === index ? value : id)),
      }));
    },
    [updateForm]
  );

  const handleAddDeciderRow = useCallback(() => {
    updateForm(prev => ({
      ...prev,
      deciderModels: [...prev.deciderModels, { id: '' }],
    }));
  }, [updateForm]);

  const handleRemoveDeciderRow = useCallback(
    (index: number) => {
      updateForm(prev => ({
        ...prev,
        deciderModels: prev.deciderModels.filter((_, i) => i !== index),
      }));
    },
    [updateForm]
  );

  const handleDeciderRowChange = useCallback(
    (index: number, patch: Partial<DeciderModelRow>) => {
      updateForm(prev => ({
        ...prev,
        deciderModels: prev.deciderModels.map((row, i) =>
          i === index ? { ...row, ...patch } : row
        ),
      }));
    },
    [updateForm]
  );

  const handleSave = useCallback(() => {
    saveMutation.mutate(formStateToConfig(form, config));
  }, [form, config, saveMutation]);

  // Effective/computed/override per policy setting, resolved from the live form
  // so an unsaved override shows immediately, against the server's computed map.
  const policyStates = useMemo(
    () =>
      resolvePolicySettings({
        minAccuracy: form.minAccuracy,
        accuracyNoiseBand: form.accuracyNoiseBand,
        frontierMinAccuracyDelta: form.frontierMinAccuracyDelta,
        productionTokenProfile: parseTokenProfile(form),
        switchHorizonTurns: parseOptionalNumber(form.switchHorizonTurns),
        switchCostFactor: form.switchCostFactor,
        bestAccuracySwitchThreshold: form.bestAccuracySwitchThreshold,
        lowConfidenceThreshold: parseOptionalNumber(form.lowConfidenceThreshold),
        classifierRepetitions: form.classifierRepetitions,
        deciderRepetitions: form.deciderRepetitions,
        classifierMaxP95LatencyMs: parseOptionalNumber(form.classifierMaxP95LatencyMs),
        policyOverrides: policyOverridesFromForm(form.policyOverrides),
        policyComputed: config?.policyComputed ?? null,
      }),
    [form, config]
  );

  const setOverride = useCallback(
    (patch: Partial<PolicyOverrideForm>) => {
      updateForm(prev => ({
        ...prev,
        policyOverrides: { ...prev.policyOverrides, ...patch },
      }));
    },
    [updateForm]
  );

  const modalityCoverage = useMemo(
    () =>
      computePoolModalityCoverage({
        poolModelIds: form.deciderModels.map(row => row.id.trim()).filter(id => id.length > 0),
        catalog: catalogModalities,
      }),
    [form.deciderModels, catalogModalities]
  );
  return (
    <Card className="rounded-lg">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Benchmark Config</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 pt-0">
        <ConfigSectionHeading
          title="Models"
          description="Classifier and decider models measured by the benchmark queues."
        />
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-medium">Classifier models</Label>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {form.classifierModels.map((modelId, index) => (
                  <TableRow key={index}>
                    <TableCell className="py-2">
                      <ModelCombobox
                        variant="compact"
                        models={classifierModelOptions}
                        value={modelId}
                        onValueChange={value => handleClassifierModelChange(index, value)}
                        pinnedModel={
                          modelId && !classifierModelOptions.some(option => option.id === modelId)
                            ? pinnedModelFor(modelId)
                            : undefined
                        }
                        isLoading={classifierModelsLoading}
                        error={classifierModelsError}
                        className="w-full"
                        triggerAriaLabel={`Classifier model ${index + 1}`}
                      />
                    </TableCell>
                    <TableCell className="py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleRemoveClassifierRow(index)}
                        aria-label={`Remove classifier model ${index + 1}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={handleAddClassifierRow}
          >
            <Plus className="size-3.5" />
            Add model
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-medium">Decider models</Label>
          <p className="text-muted-foreground text-xs">
            Each selected model benchmarks every supported reasoning effort. Queue status is shown
            in the registry below.
          </p>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Effort coverage</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {form.deciderModels.map((row, index) => {
                  return (
                    <TableRow key={index}>
                      <TableCell className="py-2">
                        <ModelCombobox
                          variant="compact"
                          models={modelOptions}
                          value={row.id}
                          onValueChange={value => handleDeciderRowChange(index, { id: value })}
                          pinnedModel={
                            row.id && !modelOptions.some(option => option.id === row.id)
                              ? pinnedModelFor(row.id)
                              : undefined
                          }
                          isLoading={modelsLoading}
                          error={modelsError}
                          className="w-full"
                          triggerAriaLabel={`Decider model ${index + 1}`}
                        />
                      </TableCell>
                      <TableCell className="py-2">
                        {row.id
                          ? effortCoverageForModel(
                              modelOptions.find(model => model.id === row.id),
                              registryEntries
                            )
                          : null}
                      </TableCell>
                      <TableCell className="py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => handleRemoveDeciderRow(index)}
                          aria-label={`Remove decider model ${index + 1}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={handleAddDeciderRow}
          >
            <Plus className="size-3.5" />
            Add model
          </Button>
        </div>

        <PoolModalityWarning coverage={modalityCoverage} />

        <ConfigSectionHeading
          title="Ranking"
          description="How candidates are filtered and costed before a routing table is published."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <PolicySettingField
              state={policyStates.minAccuracy}
              overridden={policyStates.minAccuracy.override !== null}
              help="Chosen by a held-out grid over the measured registry: the middle of the stable plateau with the best accuracy per estimated request dollar."
            >
              <Input
                id="benchmark-min-accuracy-override"
                type="text"
                inputMode="decimal"
                value={form.policyOverrides.minAccuracy}
                onChange={e => setOverride({ minAccuracy: e.target.value })}
                className="h-8 w-28 tabular-nums"
                placeholder={formatPolicyValue(
                  policyStates.minAccuracy.computed?.value ?? policyStates.minAccuracy.effective
                )}
                aria-label="Minimum accuracy override"
              />
              <UseSystemValueButton
                overridden={policyStates.minAccuracy.override !== null}
                onClick={() => setOverride({ minAccuracy: '' })}
                label="Use the system minimum accuracy"
              />
            </PolicySettingField>
          </div>
          <div className="sm:col-span-2">
            <PolicySettingField
              state={policyStates.accuracyNoiseBand}
              overridden={policyStates.accuracyNoiseBand.override !== null}
              help="Candidates within this band of the threshold compete on value. Chosen by the same held-out grid as the minimum accuracy."
            >
              <Input
                id="benchmark-accuracy-noise-band-override"
                type="text"
                inputMode="decimal"
                value={form.policyOverrides.accuracyNoiseBand}
                onChange={e => setOverride({ accuracyNoiseBand: e.target.value })}
                className="h-8 w-28 tabular-nums"
                placeholder={formatPolicyValue(
                  policyStates.accuracyNoiseBand.computed?.value ??
                    policyStates.accuracyNoiseBand.effective
                )}
                aria-label="Accuracy noise band override"
              />
              <UseSystemValueButton
                overridden={policyStates.accuracyNoiseBand.override !== null}
                onClick={() => setOverride({ accuracyNoiseBand: '' })}
                label="Use the system accuracy noise band"
              />
            </PolicySettingField>
          </div>
          {router === 'frontier' ? (
            <div className="sm:col-span-2">
              <PolicySettingField
                state={policyStates.frontierMinAccuracyDelta}
                overridden={false}
              />
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <PolicySettingField
              state={policyStates.productionTokenProfile}
              overridden={policyStates.productionTokenProfile.override !== null}
              help="Mean input tokens per production auto request, measured from real usage. Ranking adds their cost at each model's prompt and cache-read prices."
            >
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="benchmark-uncached-input-tokens-override"
                  className="text-muted-foreground text-xs"
                >
                  Uncached input tokens
                </Label>
                <Input
                  id="benchmark-uncached-input-tokens-override"
                  type="text"
                  inputMode="numeric"
                  value={form.policyOverrides.uncachedInputTokens}
                  onChange={e => setOverride({ uncachedInputTokens: e.target.value })}
                  className="h-8 w-40 tabular-nums"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="benchmark-cached-input-tokens-override"
                  className="text-muted-foreground text-xs"
                >
                  Cached input tokens
                </Label>
                <Input
                  id="benchmark-cached-input-tokens-override"
                  type="text"
                  inputMode="numeric"
                  value={form.policyOverrides.cachedInputTokens}
                  onChange={e => setOverride({ cachedInputTokens: e.target.value })}
                  className="h-8 w-40 tabular-nums"
                />
              </div>
              <UseSystemValueButton
                overridden={policyStates.productionTokenProfile.override !== null}
                onClick={() => setOverride({ uncachedInputTokens: '', cachedInputTokens: '' })}
                label="Use the system production token profile"
              />
            </PolicySettingField>
          </div>
        </div>

        <ConfigSectionHeading
          title="Switching"
          description="When a session keeps its incumbent model instead of switching."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <PolicySettingField
              state={policyStates.switchHorizonTurns}
              overridden={policyStates.switchHorizonTurns.override !== null}
              help="Switch to a cheaper model only when savings over this many turns exceed the lost prompt cache. Taken from the median number of requests in a production auto session."
            >
              <Input
                id="benchmark-switch-horizon-turns-override"
                type="text"
                inputMode="numeric"
                value={form.policyOverrides.switchHorizonTurns}
                onChange={e => setOverride({ switchHorizonTurns: e.target.value })}
                className="h-8 w-28 tabular-nums"
                placeholder={formatPolicyValue(
                  policyStates.switchHorizonTurns.computed?.value ??
                    policyStates.switchHorizonTurns.effective
                )}
                aria-label="Switch horizon override"
              />
              <UseSystemValueButton
                overridden={policyStates.switchHorizonTurns.override !== null}
                onClick={() => setOverride({ switchHorizonTurns: '' })}
                label="Use the system switch horizon"
              />
            </PolicySettingField>
          </div>
          <div className="sm:col-span-2">
            <PolicySettingField state={policyStates.switchCostFactor} overridden={false} />
          </div>
          <div className="sm:col-span-2">
            <PolicySettingField
              state={policyStates.bestAccuracySwitchThreshold}
              overridden={false}
            />
          </div>
          <div className="sm:col-span-2">
            <PolicySettingField state={policyStates.lowConfidenceThreshold} overridden={false} />
          </div>
        </div>

        <ConfigSectionHeading
          title="Benchmark runs"
          description="Container budget, repetitions, run identity, and the latency gate."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">Shared container budget</span>
            <p className="text-muted-foreground text-xs">
              {BENCHMARK_CONTAINER_BUDGET} benchmark containers are shared by every queue and both
              routers. User-queue runs use at most{' '}
              {BENCHMARK_CONTAINER_BUDGET - BENCHMARK_PLATFORM_RESERVED_CONTAINERS}; the remaining{' '}
              {BENCHMARK_PLATFORM_RESERVED_CONTAINERS} stay reserved for platform runs, which split
              the free lanes with the other router.
            </p>
          </div>
          <div className="sm:col-span-2">
            <PolicySettingField state={policyStates.classifierRepetitions} overridden={false} />
          </div>
          <div className="sm:col-span-2">
            <PolicySettingField state={policyStates.deciderRepetitions} overridden={false} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-user-id" className="text-sm font-medium">
              Benchmark user override
            </Label>
            <Input
              id="benchmark-user-id"
              value={form.benchmarkUserId}
              onChange={e => updateForm(prev => ({ ...prev, benchmarkUserId: e.target.value }))}
              className="h-8 font-mono text-xs"
              placeholder={`Default: ${DEFAULT_BENCHMARK_USER_ID}`}
            />
            <p className="text-muted-foreground text-xs">
              Leave blank to run decider benchmarks as the default benchmark user.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-org-id" className="text-sm font-medium">
              Benchmark org override
            </Label>
            <Input
              id="benchmark-org-id"
              value={form.benchmarkOrgId}
              onChange={e => updateForm(prev => ({ ...prev, benchmarkOrgId: e.target.value }))}
              className="h-8 font-mono text-xs"
              placeholder={`Default: ${DEFAULT_BENCHMARK_ORG_ID}`}
            />
            <p className="text-muted-foreground text-xs">
              Leave blank to bill decider benchmarks to the default benchmark org.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <PolicySettingField state={policyStates.classifierMaxP95LatencyMs} overridden={false} />
        </div>
      </CardContent>

      <div className="bg-card sticky bottom-0 flex flex-col gap-2 rounded-b-xl border-t p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={handleSave} disabled={saveMutation.isPending}>
            <Save className="size-4" />
            Save config
          </Button>
          {dirty ? (
            <>
              <Button type="button" variant="outline" onClick={handleReload}>
                Discard &amp; reload
              </Button>
              <span className="text-muted-foreground text-xs">Unsaved changes</span>
            </>
          ) : null}
        </div>
        {config === null ? (
          <p className="text-muted-foreground text-xs">
            No config saved yet — runs cannot start until one is saved.
          </p>
        ) : config.updatedAt ? (
          <p className="text-muted-foreground text-xs">
            Last updated {config.updatedAt}
            {config.updatedBy ? ` by ${config.updatedBy}` : ''}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Run summaries expandable table
// ---------------------------------------------------------------------------

function RunSummariesTable({ run, id }: { run: BenchmarkRun; id: string }) {
  const isDecider = run.kind === 'decider';

  const sortedSummaries: BenchmarkModelSummary[] = isDecider
    ? [...run.summaries].sort((a, b) => {
        const routeDiff = a.routeKey.localeCompare(b.routeKey);
        if (routeDiff !== 0) return routeDiff;
        return b.accuracy - a.accuracy;
      })
    : run.summaries;

  return (
    <TableRow className="bg-muted/30">
      <TableCell colSpan={6} id={id} className="px-4 py-2">
        {/* Full error text (the collapsed row's Error cell is truncated). */}
        {run.error ? (
          <div className="border-destructive/40 bg-destructive/10 text-destructive mb-2 rounded-md border px-3 py-2 text-xs whitespace-pre-wrap break-words">
            {run.error}
          </div>
        ) : null}
        {sortedSummaries.length === 0 ? (
          <p className="text-muted-foreground py-1 text-center text-xs">No summaries</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-max">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Model</TableHead>
                  {isDecider ? <TableHead className="text-xs">Route</TableHead> : null}
                  <TableHead className="text-right text-xs">Accuracy</TableHead>
                  {isDecider ? null : (
                    <TableHead className="text-right text-xs">Route accuracy</TableHead>
                  )}
                  <TableHead className="text-right text-xs">Avg cost</TableHead>
                  <TableHead className="text-right text-xs">Avg latency</TableHead>
                  <TableHead className="text-right text-xs">p50 latency</TableHead>
                  <TableHead className="text-right text-xs">p95 latency</TableHead>
                  <TableHead className="text-right text-xs">Cases</TableHead>
                  <TableHead className="text-right text-xs">Errors</TableHead>
                  <TableHead className="text-right text-xs">Timeouts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedSummaries.map((s, i) => (
                  <TableRow key={`${s.model}-${s.routeKey}-${i}`}>
                    <TableCell className="max-w-56 truncate font-mono text-xs">{s.model}</TableCell>
                    {isDecider ? (
                      <TableCell className="font-mono text-xs">{s.routeKey}</TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums text-xs">
                      {formatAccuracy(s.accuracy)}
                    </TableCell>
                    {isDecider ? null : (
                      <TableCell className="text-right tabular-nums text-xs">
                        {s.routeAccuracy !== null ? formatAccuracy(s.routeAccuracy) : '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums text-xs">
                      {formatUsd(s.avgCostUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {s.avgLatencyMs.toFixed(0)} ms
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {s.p50LatencyMs !== null ? `${s.p50LatencyMs.toFixed(0)} ms` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {s.p95LatencyMs !== null ? `${s.p95LatencyMs.toFixed(0)} ms` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{s.cases}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{s.errors}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{s.timeouts}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Runs table
// ---------------------------------------------------------------------------

function statusBadgeVariant(
  status: BenchmarkRun['status']
): 'default' | 'secondary' | 'destructive' {
  if (status === 'completed') return 'default';
  if (status === 'running') return 'secondary';
  return 'destructive';
}

function RunProgress({
  progress,
  startedAt,
}: {
  progress: BenchmarkRunProgress;
  startedAt: string;
}) {
  const { percent, counts, eta } = formatRunProgress(progress, startedAt);
  return (
    <div className="mt-1.5 flex w-40 flex-col gap-1">
      {percent === null ? null : (
        <Progress value={percent} className="h-1.5" aria-label={`Benchmark progress: ${counts}`} />
      )}
      <span className="text-muted-foreground text-[11px] tabular-nums">
        {counts}
        {eta === null ? '' : ` · ETA ${eta}`}
      </span>
    </div>
  );
}

function BenchmarkRunsTable({ runs }: { runs: BenchmarkRun[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (runs.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={6} className="text-muted-foreground h-16 text-center">
          No runs yet
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      {runs.map(run => {
        const expanded = expandedIds.has(run.id);
        const summariesId = `run-summaries-${run.id}`;
        return (
          <React.Fragment key={run.id}>
            {/* Row click is a mouse convenience; the button in the first cell is
                the accessible (keyboard/AT) control that owns aria-expanded. */}
            <TableRow className="cursor-pointer" onClick={() => toggleExpand(run.id)}>
              <TableCell className="w-8 py-2">
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    toggleExpand(run.id);
                  }}
                  aria-expanded={expanded}
                  aria-controls={expanded ? summariesId : undefined}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${runTypeLabel(run)} run details`}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-5 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
                >
                  {expanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </button>
              </TableCell>
              <TableCell className="py-2 text-sm">
                <Badge variant={run.kind === 'classifier' ? 'outline' : 'secondary'}>
                  {runTypeLabel(run)}
                </Badge>
              </TableCell>
              <TableCell className="py-2">
                <Badge variant={statusBadgeVariant(run.status)} className="capitalize">
                  {run.status}
                </Badge>
                {run.progress ? (
                  <RunProgress progress={run.progress} startedAt={run.startedAt} />
                ) : null}
              </TableCell>
              <TableCell className="py-2 text-xs tabular-nums">{run.startedAt}</TableCell>
              <TableCell className="py-2 text-xs tabular-nums">{run.completedAt ?? '—'}</TableCell>
              <TableCell
                className="py-2 text-xs text-destructive max-w-48 truncate"
                title={run.error ?? undefined}
              >
                {run.error ?? ''}
              </TableCell>
            </TableRow>
            {expanded ? <RunSummariesTable run={run} id={summariesId} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Routing table view
// ---------------------------------------------------------------------------

function RoutingTableSummary({ table }: { table: BenchmarkRoutingTableResponse['table'] }) {
  if (!table) return null;

  const tokenProfile = table.productionTokenProfile;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      <dt className="text-muted-foreground">Version</dt>
      <dd className="font-mono">{table.version}</dd>
      <dt className="text-muted-foreground">Generated at</dt>
      <dd className="tabular-nums">{table.generatedAt}</dd>
      <dt className="text-muted-foreground">Min accuracy</dt>
      <dd className="tabular-nums">{formatAccuracy(table.minAccuracy)}</dd>
      <dt className="text-muted-foreground">Switch horizon</dt>
      <dd className="tabular-nums">
        {table.switchHorizonTurns != null
          ? `${table.switchHorizonTurns} turns`
          : `cost factor ${table.switchCostFactor}`}
      </dd>
      <dt className="text-muted-foreground">Token profile</dt>
      <dd className="tabular-nums">
        {tokenProfile
          ? `${tokenProfile.uncachedInputTokens} uncached / ${tokenProfile.cachedInputTokens} cached`
          : 'not set'}
      </dd>
      <dt className="text-muted-foreground">Source</dt>
      <dd className="capitalize">{table.source}</dd>
    </dl>
  );
}

export function RoutingTableView({ data }: { data: BenchmarkRoutingTableResponse }) {
  if (!data.table) {
    return <p className="text-muted-foreground text-sm">No routing table published yet.</p>;
  }

  const { table } = data;
  const routeEntries = Object.entries(table.routes).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-3">
      {routeEntries.map(([routeKey, candidates]) => {
        const first = candidates[0];
        return (
          <Collapsible key={routeKey} className="rounded-md border">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size={null}
                className="min-h-11 w-full justify-start gap-3 whitespace-normal px-3 py-2 text-left [&[data-state=open]>svg]:rotate-90"
              >
                <ChevronRight className="size-4 shrink-0" />
                <span className="grid flex-1 gap-x-4 gap-y-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto]">
                  <span className="break-all font-mono text-xs">{routeKey}</span>
                  <span className="break-all text-xs">
                    <span className="text-muted-foreground">First-ranked: </span>
                    {first
                      ? `${first.model} · ${first.variant ?? first.reasoningEffort ?? 'default'}`
                      : 'No ranked pairs'}
                  </span>
                  <span className="text-xs tabular-nums">
                    {first ? `Accuracy ${formatAccuracy(first.accuracy)}` : '—'}
                  </span>
                  <span className="text-xs tabular-nums">
                    {first ? `Avg cost ${formatUsd(first.avgCostUsd)}` : '—'}
                  </span>
                  <span className="text-xs">
                    {first ? (first.meetsThreshold ? 'Meets threshold' : 'Below threshold') : '—'}
                  </span>
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="overflow-x-auto border-t">
                <Table className="min-w-max">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="w-36">Effort</TableHead>
                      <TableHead className="text-right">Accuracy</TableHead>
                      <TableHead className="text-right">Avg cost</TableHead>
                      <TableHead className="text-right">Cost / accuracy</TableHead>
                      <TableHead>Threshold</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidates.map((c, i) => (
                      <TableRow key={`${routeKey}-${c.model}-${i}`}>
                        <TableCell className="text-xs tabular-nums">{i + 1}</TableCell>
                        <TableCell className="max-w-56 break-all font-mono text-xs">
                          {c.model}
                        </TableCell>
                        <TableCell className="capitalize text-xs">
                          {c.variant ?? c.reasoningEffort ?? 'default'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatAccuracy(c.accuracy)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatUsd(c.avgCostUsd)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatCostPerAccuracy(c)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={c.meetsThreshold ? 'default' : 'secondary'}>
                            {c.meetsThreshold ? 'meets' : 'below'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry summary
// ---------------------------------------------------------------------------

const REGISTRY_STATUSES = ['pending', 'running', 'ready', 'failed'] as const;

function RegistrySummary({
  data,
  router,
}: {
  router: AutoRouter;
  data: {
    engineIdentity: string;
    repetitions: number;
    platform: BenchmarkRegistryQueue;
    user: BenchmarkRegistryQueue;
  };
}) {
  const queues: { label: string; queue: BenchmarkRegistryQueue }[] = [
    { label: 'Platform queue', queue: data.platform },
    ...(router === 'efficient' ? [{ label: 'User queue', queue: data.user }] : []),
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              <TableHead>Queue</TableHead>
              {REGISTRY_STATUSES.map(status => (
                <TableHead key={status} className="text-right capitalize">
                  {status}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {queues.map(({ label, queue }) => (
              <TableRow key={label}>
                <TableCell className="text-sm">{label}</TableCell>
                {REGISTRY_STATUSES.map(status => (
                  <TableCell key={status} className="text-right tabular-nums text-sm">
                    {queue[status]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">
        Engine <span className="font-mono">{data.engineIdentity}</span>, {data.repetitions}{' '}
        {data.repetitions === 1 ? 'repetition' : 'repetitions'}. Counts exclude entries measured
        under an older engine identity.
        {router === 'efficient' ? ' Entries wanted by both queues share one measurement.' : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main exported section component
// ---------------------------------------------------------------------------

export function RouterBenchmarksSection({ router }: { router: AutoRouter }) {
  const queryClient = useQueryClient();
  const [forceRerun, setForceRerun] = useState(false);
  const [runFilter, setRunFilter] = useState<RunFilter>('all');

  const modelsQuery = useModelSelectorList(undefined);
  const modelOptions = useMemo(() => {
    const models = modelsQuery.data?.data ?? [];
    const coverage = new Map(
      models.map(model => [model.id, getReasoningVariantKeys(model.opencode?.variants)])
    );
    return toEligibleModelOptions(models, []).map(model => ({
      ...model,
      reasoningVariants: coverage.get(model.id),
    }));
  }, [modelsQuery.data?.data]);
  const modelsError = modelsQuery.error instanceof Error ? modelsQuery.error.message : undefined;
  const catalogModalities = useMemo(
    () =>
      (modelsQuery.data?.data ?? []).map(model => ({
        id: model.id,
        inputModalities: model.architecture?.input_modalities,
      })),
    [modelsQuery.data?.data]
  );
  const systemOneModelsQuery = useSystemOneModelOptions();
  const systemOneModelsError =
    systemOneModelsQuery.error instanceof Error ? systemOneModelsQuery.error.message : undefined;

  const configQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-config', router],
    queryFn: () => fetchBenchmarkConfig(router),
  });

  const runsQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-runs', router, runFilter],
    queryFn: () => fetchBenchmarkRuns(runFilter, router),
  });

  const registryQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-registry', router],
    queryFn: () => fetchBenchmarkRegistry(router),
  });

  const routingTableQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-routing-table', router],
    queryFn: () => fetchBenchmarkRoutingTable(router),
  });

  // Run activity drives polling and cache invalidation, so it must not depend
  // on what the list is filtered to — a platform run finishing while the admin
  // reads the classifier list is still a completion. On the 'all' filter this
  // shares its key with runsQuery, so it costs no extra request.
  const allRunsQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-runs', router, 'all'],
    queryFn: () => fetchBenchmarkRuns('all', router),
  });

  // Poll runs every 30s while any run is 'running'
  const hasRunningRun = allRunsQuery.data?.runs.some(r => r.status === 'running') ?? false;
  const refetchRuns = runsQuery.refetch;
  const refetchAllRuns = allRunsQuery.refetch;
  useEffect(() => {
    if (!hasRunningRun) return;
    const id = setInterval(() => {
      void refetchRuns();
      void refetchAllRuns();
    }, 30_000);
    return () => clearInterval(id);
  }, [hasRunningRun, refetchRuns, refetchAllRuns]);

  // When the last running run finishes, its completion publishes a routing
  // table / classifier winner. Those live in their own query caches, so
  // invalidate them on the running→terminal edge — otherwise the published
  // routing table keeps showing stale data (or "No routing table published
  // yet") until a focus refetch or manual reload.
  const prevHasRunningRun = useRef(hasRunningRun);
  useEffect(() => {
    if (prevHasRunningRun.current && !hasRunningRun) {
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-routing-table', router],
      });
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-config', router],
      });
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-registry', router],
      });
    }
    prevHasRunningRun.current = hasRunningRun;
  }, [hasRunningRun, queryClient, router]);

  const startRunMutation = useMutation({
    mutationFn: (input: { kind: BenchmarkKind; force: boolean; queue: BenchmarkQueueSelector }) =>
      startBenchmarkRun({ ...input, router }),
    onSuccess: (data, variables) => {
      if (variables.kind === 'classifier') {
        toast.success(
          data.enqueuedModels === 0
            ? 'All classifier models already have results — republished from existing data'
            : `Classifier benchmark started — ${data.enqueuedModels} models enqueued, ${data.skippedModels.length} skipped`
        );
      } else if (data.startedRuns.length === 0) {
        // Honest empty result: nothing pending, or the queue's slot is busy.
        toast.success('Nothing to run — no pending registry entries for that queue');
      } else {
        toast.success(
          data.startedRuns.map(run => `${run.purpose} queue: ${run.entryCount} entries`).join(' · ')
        );
      }
      // One queue can start while the other is wedged. Say so, or its pending
      // work looks the same as an empty queue.
      for (const message of data.drainErrors) {
        toast.error(`A queue could not start: ${message}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-runs', router] });
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-registry', router],
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start benchmark run');
    },
  });

  const requeueMutation = useMutation({
    mutationFn: (scope: BenchmarkQueueSelector) => requeueBenchmarkRegistry(scope, router),
    onSuccess: data => {
      toast.success(
        data.requeued === 0
          ? 'No failed entries to requeue'
          : `${data.requeued} failed ${data.requeued === 1 ? 'entry' : 'entries'} requeued`
      );
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-registry', router],
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to requeue entries');
    },
  });

  const handleConfigSaved = useCallback(
    (next: { config: BenchmarkConfig | null }) => {
      queryClient.setQueryData(['auto-routing', 'benchmark-config', router], next);
    },
    [queryClient, router]
  );

  return (
    <Tabs defaultValue="policy">
      <TabsList className="h-8">
        <TabsTrigger value="policy" className="px-2.5 text-xs">
          Policy
        </TabsTrigger>
        <TabsTrigger value="routing-table" className="px-2.5 text-xs">
          Routing table
        </TabsTrigger>
        <TabsTrigger value="benchmarks" className="px-2.5 text-xs">
          Benchmarks
          {hasRunningRun ? (
            <span className="text-primary ml-1.5 text-[10px] font-medium">Running</span>
          ) : null}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="policy" className="mt-4">
        {configQuery.isLoading ? (
          <Card className="rounded-lg">
            <CardContent className="p-4">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        ) : configQuery.error ? (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {configQuery.error instanceof Error
              ? configQuery.error.message
              : 'Failed to load benchmark config'}
          </div>
        ) : configQuery.data ? (
          <BenchmarkConfigEditor
            router={router}
            config={configQuery.data.config}
            onSaved={handleConfigSaved}
            modelOptions={modelOptions}
            modelsLoading={modelsQuery.isLoading}
            modelsError={modelsError}
            registryEntries={registryQuery.data?.platformEntries}
            classifierModelOptions={systemOneModelsQuery.data ?? []}
            classifierModelsLoading={systemOneModelsQuery.isLoading}
            classifierModelsError={systemOneModelsError}
            catalogModalities={catalogModalities}
          />
        ) : null}
      </TabsContent>

      <TabsContent value="benchmarks" className="mt-4 flex flex-col gap-4">
        <Card className="rounded-lg">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Decider Registry</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            <p className="text-muted-foreground text-xs">
              Measurements and published tables are isolated for the selected router. Classifier
              measurements are shared. Custom owner pools use the efficient router only.
            </p>
            {registryQuery.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : registryQuery.error ? (
              <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                {registryQuery.error instanceof Error
                  ? registryQuery.error.message
                  : 'Failed to load registry'}
              </div>
            ) : registryQuery.data ? (
              <RegistrySummary data={registryQuery.data} router={router} />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={startRunMutation.isPending}
                onClick={() =>
                  startRunMutation.mutate({ kind: 'decider', force: false, queue: 'platform' })
                }
              >
                <Play className="size-4" />
                Run platform queue
              </Button>
              {router === 'efficient' ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={startRunMutation.isPending}
                    onClick={() =>
                      startRunMutation.mutate({ kind: 'decider', force: false, queue: 'user' })
                    }
                  >
                    <Play className="size-4" />
                    Run user queue
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={startRunMutation.isPending}
                    onClick={() =>
                      startRunMutation.mutate({ kind: 'decider', force: false, queue: 'both' })
                    }
                  >
                    <Play className="size-4" />
                    Run both queues
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={requeueMutation.isPending}
                onClick={() => requeueMutation.mutate(router === 'efficient' ? 'both' : 'platform')}
              >
                <RotateCcw className="size-4" />
                Requeue failed
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Queues also drain on a timer. A queue whose run is already active is skipped.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Run Classifier Benchmark</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            <p className="text-muted-foreground text-xs">
              Classifier candidates are not registry-tracked: models with existing results are
              skipped unless "Re-run models with existing results" is checked.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="force-rerun"
                checked={forceRerun}
                onCheckedChange={checked => setForceRerun(checked === true)}
              />
              <Label htmlFor="force-rerun" className="text-sm font-normal cursor-pointer">
                Re-run models with existing results
              </Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={startRunMutation.isPending}
                onClick={() =>
                  startRunMutation.mutate({
                    kind: 'classifier',
                    force: forceRerun,
                    queue: 'platform',
                  })
                }
              >
                <Play className="size-4" />
                Run classifier benchmark
              </Button>
              {hasRunningRun ? (
                <p className="text-muted-foreground self-center text-xs">
                  A benchmark is running — refreshing every 30 s
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader className="flex flex-row items-center justify-between gap-3 p-4 pb-2">
            <CardTitle className="text-base">Benchmark Runs</CardTitle>
            <Select value={runFilter} onValueChange={value => setRunFilter(value as RunFilter)}>
              <SelectTrigger className="h-8 w-44 text-xs" aria-label="Filter runs by type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(router === 'efficient'
                  ? (['all', 'classifier', 'platform', 'user'] as const)
                  : (['all', 'classifier', 'platform'] as const)
                ).map(value => (
                  <SelectItem key={value} value={value}>
                    {RUN_FILTER_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {runsQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : runsQuery.error ? (
              <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                {runsQuery.error instanceof Error
                  ? runsQuery.error.message
                  : 'Failed to load benchmark runs'}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <BenchmarkRunsTable runs={runsQuery.data?.runs ?? []} />
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="routing-table" className="mt-4">
        <Card className="rounded-lg">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Published Routing Table</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4 pt-0">
            {routingTableQuery.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : routingTableQuery.error ? (
              <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
                {routingTableQuery.error instanceof Error
                  ? routingTableQuery.error.message
                  : 'Failed to load routing table'}
              </div>
            ) : routingTableQuery.data ? (
              <>
                <RoutingTableSummary table={routingTableQuery.data.table} />
                <RoutingTableView data={routingTableQuery.data} />
              </>
            ) : null}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
