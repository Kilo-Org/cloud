'use client';

import {
  AUTO_DECIDER_DEFAULT_MAX_COST_USD,
  AUTO_DECIDER_DEFAULT_MIN_COST_USD,
  BenchmarkConfigResponseSchema,
  BenchmarkRoutingTableResponseSchema,
  BenchmarkRunsResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkKind,
  type BenchmarkRoutingTableResponse,
  type BenchmarkRun,
  type BenchmarkModelSummary,
  type RankedCandidate,
  type ReasoningEffort,
  type AutoBenchmarkDeciderModel,
} from '@kilocode/auto-routing-contracts';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Play, Plus, Save, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { parseAdminResponse } from './admin-fetch';

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

export function formatCostPerAccuracy(candidate: Pick<RankedCandidate, 'accuracy' | 'avgCostUsd'>) {
  const value = costPerAccuracy(candidate);
  return Number.isFinite(value) ? formatUsd(value) : '—';
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchBenchmarkConfig() {
  const response = await fetch('/admin/api/auto-routing/benchmark-config');
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

async function fetchBenchmarkRuns() {
  const response = await fetch('/admin/api/auto-routing/benchmark-runs');
  return parseAdminResponse(response, BenchmarkRunsResponseSchema);
}

async function startBenchmarkRun({ kind, force }: { kind: BenchmarkKind; force: boolean }) {
  const response = await fetch('/admin/api/auto-routing/benchmark-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, force }),
  });
  return parseAdminResponse(response, StartBenchmarkRunResponseSchema);
}

async function fetchBenchmarkRoutingTable() {
  const response = await fetch('/admin/api/auto-routing/benchmark-routing-table');
  return parseAdminResponse<BenchmarkRoutingTableResponse>(
    response,
    BenchmarkRoutingTableResponseSchema
  );
}

// ---------------------------------------------------------------------------
// Local form state type for decider model rows
// ---------------------------------------------------------------------------

type DeciderModelRow = {
  id: string;
  reasoningEffort: ReasoningEffort | null;
};

type AutoDeciderModelRow = AutoBenchmarkDeciderModel;

const DEFAULT_BENCHMARK_USER_ID = 'ce12ef3d-ae95-4d77-b4f0-23735f0a0591';
const DEFAULT_BENCHMARK_ORG_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

export function configToFormState(config: BenchmarkConfig | null): {
  classifierModels: string;
  deciderModels: DeciderModelRow[];
  autoDeciderModels: AutoDeciderModelRow[];
  excludedAutoDeciderModels: string;
  minAccuracy: number;
  switchCostFactor: number;
  maxConcurrency: number;
  benchmarkUserId: string;
  benchmarkOrgId: string;
  classifierRepetitions: number;
  deciderRepetitions: number;
  classifierMaxP95LatencyMs: string;
  autoDeciderMinCostUsd: number;
  autoDeciderMaxCostUsd: number;
} {
  if (config === null) {
    // No config saved yet: the worker fabricates nothing, so the form starts
    // empty and the admin must enter and save a config before running.
    return {
      classifierModels: '',
      deciderModels: [],
      autoDeciderModels: [],
      excludedAutoDeciderModels: '',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      maxConcurrency: 100,
      benchmarkUserId: DEFAULT_BENCHMARK_USER_ID,
      benchmarkOrgId: DEFAULT_BENCHMARK_ORG_ID,
      classifierRepetitions: 1,
      deciderRepetitions: 1,
      classifierMaxP95LatencyMs: '1000',
      autoDeciderMinCostUsd: AUTO_DECIDER_DEFAULT_MIN_COST_USD,
      autoDeciderMaxCostUsd: AUTO_DECIDER_DEFAULT_MAX_COST_USD,
    };
  }
  return {
    classifierModels: config.classifierModels.join('\n'),
    deciderModels: (config.manualDeciderModels ?? config.deciderModels).map(m => ({
      id: m.id,
      reasoningEffort: m.reasoningEffort ?? null,
    })),
    autoDeciderModels: config.autoDeciderModels ?? [],
    excludedAutoDeciderModels: (config.excludedAutoDeciderModels ?? []).join('\n'),
    minAccuracy: config.minAccuracy,
    switchCostFactor: config.switchCostFactor,
    maxConcurrency: config.maxConcurrency,
    benchmarkUserId: config.benchmarkUserId ?? '',
    benchmarkOrgId: config.benchmarkOrgId ?? '',
    classifierRepetitions: config.classifierRepetitions,
    deciderRepetitions: config.deciderRepetitions,
    classifierMaxP95LatencyMs:
      config.classifierMaxP95LatencyMs !== null ? String(config.classifierMaxP95LatencyMs) : '',
    autoDeciderMinCostUsd: config.autoDeciderMinCostUsd,
    autoDeciderMaxCostUsd: config.autoDeciderMaxCostUsd,
  };
}

function parseModelLines(value: string): string[] {
  return value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function effectiveDeciderModels({
  manualDeciderModels,
  autoDeciderModels,
  excludedAutoDeciderModels,
}: {
  manualDeciderModels: DeciderModelRow[];
  autoDeciderModels: AutoDeciderModelRow[];
  excludedAutoDeciderModels: string[];
}): DeciderModelRow[] {
  const manual = manualDeciderModels
    .filter(row => row.id.trim().length > 0)
    .map(row => ({
      id: row.id.trim(),
      reasoningEffort: row.reasoningEffort ?? null,
    }));
  const manualIds = new Set(manual.map(model => model.id));
  const excludedAuto = new Set(excludedAutoDeciderModels);
  return [
    ...manual,
    ...autoDeciderModels
      .filter(model => !excludedAuto.has(model.id))
      .filter(model => !manualIds.has(model.id))
      .map(model => ({
        id: model.id,
        reasoningEffort: model.reasoningEffort ?? null,
      })),
  ];
}

export function formStateToConfig(
  state: ReturnType<typeof configToFormState>,
  base: BenchmarkConfig | null
): BenchmarkConfig {
  const classifierModels = parseModelLines(state.classifierModels);
  const excludedAutoDeciderModels = parseModelLines(state.excludedAutoDeciderModels);
  const manualDeciderModels = state.deciderModels
    .filter(row => row.id.trim().length > 0)
    .map(row => ({ id: row.id.trim(), reasoningEffort: row.reasoningEffort ?? null }));
  const deciderModels = effectiveDeciderModels({
    manualDeciderModels,
    autoDeciderModels: state.autoDeciderModels,
    excludedAutoDeciderModels,
  });
  const benchmarkUserId = state.benchmarkUserId.trim();
  const benchmarkOrgId = state.benchmarkOrgId.trim();
  const rawLatency = state.classifierMaxP95LatencyMs.trim();
  const classifierMaxP95LatencyMs = rawLatency.length > 0 ? parseInt(rawLatency, 10) || null : null;
  return {
    classifierModels,
    deciderModels,
    manualDeciderModels,
    autoDeciderModels: state.autoDeciderModels,
    excludedAutoDeciderModels,
    minAccuracy: state.minAccuracy,
    switchCostFactor: state.switchCostFactor,
    maxConcurrency: state.maxConcurrency,
    benchmarkUserId: benchmarkUserId.length > 0 ? benchmarkUserId : null,
    benchmarkOrgId: benchmarkOrgId.length > 0 ? benchmarkOrgId : null,
    classifierRepetitions: state.classifierRepetitions,
    deciderRepetitions: state.deciderRepetitions,
    classifierMaxP95LatencyMs,
    autoDeciderMinCostUsd: state.autoDeciderMinCostUsd,
    autoDeciderMaxCostUsd: state.autoDeciderMaxCostUsd,
    updatedAt: base?.updatedAt ?? null,
    updatedBy: base?.updatedBy ?? null,
  };
}

// ---------------------------------------------------------------------------
// Config editor sub-component
// ---------------------------------------------------------------------------

function BenchmarkConfigEditor({
  config,
  onSaved,
}: {
  config: BenchmarkConfig | null;
  onSaved: (next: { config: BenchmarkConfig | null }) => void;
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
    mutationFn: saveBenchmarkConfig,
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

  const handleAddDeciderRow = useCallback(() => {
    updateForm(prev => ({
      ...prev,
      deciderModels: [...prev.deciderModels, { id: '', reasoningEffort: null }],
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

  const handleToggleAutoDeciderModel = useCallback(
    (modelId: string, included: boolean) => {
      updateForm(prev => {
        const excluded = new Set(parseModelLines(prev.excludedAutoDeciderModels));
        if (included) {
          excluded.delete(modelId);
        } else {
          excluded.add(modelId);
        }
        return {
          ...prev,
          excludedAutoDeciderModels: [...excluded].sort().join('\n'),
        };
      });
    },
    [updateForm]
  );

  const handleSave = useCallback(() => {
    saveMutation.mutate(formStateToConfig(form, config));
  }, [form, config, saveMutation]);

  return (
    <Card className="rounded-lg">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Benchmark Config</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 pt-0">
        {/* Classifier models */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="benchmark-classifier-models" className="text-sm font-medium">
            Classifier models (one per line)
          </Label>
          <Textarea
            id="benchmark-classifier-models"
            value={form.classifierModels}
            onChange={e => updateForm(prev => ({ ...prev, classifierModels: e.target.value }))}
            rows={4}
            className="font-mono text-xs"
            placeholder="openai/gpt-4o-mini"
          />
        </div>

        {/* Manual decider models table */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-medium">Manual decider models</Label>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model ID</TableHead>
                  <TableHead className="w-36">Reasoning effort</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {form.deciderModels.map((row, index) => (
                  <TableRow key={index}>
                    <TableCell className="py-2">
                      <Input
                        value={row.id}
                        onChange={e => handleDeciderRowChange(index, { id: e.target.value })}
                        className="h-8 font-mono text-xs"
                        placeholder="openai/gpt-4o"
                        aria-label={`Decider model ${index + 1} ID`}
                      />
                    </TableCell>
                    <TableCell className="py-2">
                      <Select
                        value={row.reasoningEffort ?? 'none'}
                        onValueChange={value =>
                          handleDeciderRowChange(index, {
                            reasoningEffort: value === 'none' ? null : (value as ReasoningEffort),
                          })
                        }
                      >
                        <SelectTrigger
                          className="h-8 text-xs"
                          aria-label={`Model ${index + 1} reasoning effort`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="minimal">minimal</SelectItem>
                          <SelectItem value="low">low</SelectItem>
                          <SelectItem value="medium">medium</SelectItem>
                          <SelectItem value="high">high</SelectItem>
                        </SelectContent>
                      </Select>
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
                ))}
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

        {/* Auto decider models */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm font-medium">Auto decider models</Label>
            <Badge variant="secondary">{form.autoDeciderModels.length} synced</Badge>
          </div>
          {form.autoDeciderModels.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model ID</TableHead>
                    <TableHead className="w-32">Avg run</TableHead>
                    <TableHead className="w-36">Reasoning effort</TableHead>
                    <TableHead className="w-24">Included</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {form.autoDeciderModels.map(model => {
                    const excluded = parseModelLines(form.excludedAutoDeciderModels).includes(
                      model.id
                    );
                    return (
                      <TableRow key={model.id}>
                        <TableCell className="font-mono text-xs">{model.id}</TableCell>
                        <TableCell className="tabular-nums">
                          {formatUsd(model.avgAttemptCostUsd)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {model.reasoningEffort ?? 'default'}
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            checked={!excluded}
                            onCheckedChange={checked =>
                              handleToggleAutoDeciderModel(model.id, checked === true)
                            }
                            aria-label={`${excluded ? 'Include' : 'Exclude'} ${model.id}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-muted-foreground rounded-md border px-3 py-2 text-sm">
              No auto decider models synced yet.
            </div>
          )}
        </div>

        {/* Numeric inputs */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-min-accuracy" className="text-sm font-medium">
              Min accuracy (0–1)
            </Label>
            <Input
              id="benchmark-min-accuracy"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.minAccuracy}
              onChange={e =>
                updateForm(prev => ({ ...prev, minAccuracy: parseFloat(e.target.value) || 0 }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-switch-cost-factor" className="text-sm font-medium">
              Switch cost factor (1–100)
            </Label>
            <Input
              id="benchmark-switch-cost-factor"
              type="number"
              min={1}
              max={100}
              step={0.5}
              value={form.switchCostFactor}
              onChange={e =>
                updateForm(prev => ({ ...prev, switchCostFactor: parseFloat(e.target.value) || 1 }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-max-concurrency" className="text-sm font-medium">
              Max concurrency (1–100)
            </Label>
            <Input
              id="benchmark-max-concurrency"
              type="number"
              min={1}
              max={100}
              step={1}
              value={form.maxConcurrency}
              onChange={e =>
                updateForm(prev => ({ ...prev, maxConcurrency: parseInt(e.target.value, 10) || 1 }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-auto-decider-min-cost" className="text-sm font-medium">
              Auto min run cost
            </Label>
            <Input
              id="benchmark-auto-decider-min-cost"
              type="number"
              min={0}
              step={1}
              value={form.autoDeciderMinCostUsd}
              onChange={e =>
                updateForm(prev => ({
                  ...prev,
                  autoDeciderMinCostUsd: parseFloat(e.target.value) || 0,
                }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-auto-decider-max-cost" className="text-sm font-medium">
              Auto max run cost
            </Label>
            <Input
              id="benchmark-auto-decider-max-cost"
              type="number"
              min={0}
              step={1}
              value={form.autoDeciderMaxCostUsd}
              onChange={e =>
                updateForm(prev => ({
                  ...prev,
                  autoDeciderMaxCostUsd: parseFloat(e.target.value) || 0,
                }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-classifier-repetitions" className="text-sm font-medium">
              Classifier repetitions (1–5)
            </Label>
            <Input
              id="benchmark-classifier-repetitions"
              type="number"
              min={1}
              max={5}
              step={1}
              value={form.classifierRepetitions}
              onChange={e =>
                updateForm(prev => ({
                  ...prev,
                  classifierRepetitions: parseInt(e.target.value, 10) || 1,
                }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-decider-repetitions" className="text-sm font-medium">
              Decider repetitions (1–5)
            </Label>
            <Input
              id="benchmark-decider-repetitions"
              type="number"
              min={1}
              max={5}
              step={1}
              value={form.deciderRepetitions}
              onChange={e =>
                updateForm(prev => ({
                  ...prev,
                  deciderRepetitions: parseInt(e.target.value, 10) || 1,
                }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Benchmark user id */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-user-id" className="text-sm font-medium">
              Benchmark user id
            </Label>
            <Input
              id="benchmark-user-id"
              value={form.benchmarkUserId}
              onChange={e => updateForm(prev => ({ ...prev, benchmarkUserId: e.target.value }))}
              className="h-8 font-mono text-xs"
              placeholder="(unset)"
            />
            <p className="text-muted-foreground text-xs">
              Kilo user the decider CLI authenticates as.
            </p>
          </div>

          {/* Benchmark org id */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-org-id" className="text-sm font-medium">
              Benchmark org id
            </Label>
            <Input
              id="benchmark-org-id"
              value={form.benchmarkOrgId}
              onChange={e => updateForm(prev => ({ ...prev, benchmarkOrgId: e.target.value }))}
              className="h-8 font-mono text-xs"
              placeholder="(personal credits)"
            />
            <p className="text-muted-foreground text-xs">
              Optional org context; when set, decider runs bill org credits.
            </p>
          </div>
        </div>

        {/* Classifier max p95 latency */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="benchmark-classifier-max-p95-latency" className="text-sm font-medium">
            Classifier max p95 latency (ms)
          </Label>
          <Input
            id="benchmark-classifier-max-p95-latency"
            type="number"
            min={1}
            step={1}
            value={form.classifierMaxP95LatencyMs}
            onChange={e =>
              updateForm(prev => ({ ...prev, classifierMaxP95LatencyMs: e.target.value }))
            }
            className="h-8 w-40 tabular-nums"
            placeholder="(no limit)"
          />
          <p className="text-muted-foreground text-xs">
            Winner must classify under this p95 latency; empty disables the latency gate.
          </p>
        </div>

        {/* Actions + metadata */}
        <div className="flex flex-col gap-2">
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
      </CardContent>
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
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${run.kind} run details`}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-5 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
                >
                  {expanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </button>
              </TableCell>
              <TableCell className="py-2 capitalize text-sm">{run.kind}</TableCell>
              <TableCell className="py-2">
                <Badge variant={statusBadgeVariant(run.status)} className="capitalize">
                  {run.status}
                </Badge>
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

export function RoutingTableView({ data }: { data: BenchmarkRoutingTableResponse }) {
  if (!data.table) {
    return <p className="text-muted-foreground text-sm">No routing table published yet.</p>;
  }

  const { table } = data;
  const routeEntries = Object.entries(table.routes).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground text-xs flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Version: <span className="font-mono">{table.version}</span>
        </span>
        <span>Generated: {table.generatedAt}</span>
        <span>Min accuracy: {formatAccuracy(table.minAccuracy)}</span>
        <span>
          Source: <span className="capitalize">{table.source}</span>
        </span>
      </div>

      {routeEntries.map(([routeKey, candidates]) => {
        return (
          <div key={routeKey}>
            <p className="mb-1.5 font-mono text-sm font-medium">{routeKey}</p>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-max">
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Accuracy</TableHead>
                    <TableHead className="text-right">Avg cost</TableHead>
                    <TableHead className="text-right">Cost / accuracy</TableHead>
                    <TableHead>Threshold</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.map((c, i) => (
                    <TableRow key={`${routeKey}-${c.model}-${i}`}>
                      <TableCell className="max-w-56 truncate font-mono text-xs">
                        {c.model}
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
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main exported section component
// ---------------------------------------------------------------------------

export function BenchmarksSection() {
  const queryClient = useQueryClient();
  const [forceRerun, setForceRerun] = useState(false);

  const configQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-config'],
    queryFn: fetchBenchmarkConfig,
  });

  const runsQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-runs'],
    queryFn: fetchBenchmarkRuns,
  });

  const routingTableQuery = useQuery({
    queryKey: ['auto-routing', 'benchmark-routing-table'],
    queryFn: fetchBenchmarkRoutingTable,
  });

  // Poll runs every 30s while any run is 'running'
  const hasRunningRun = runsQuery.data?.runs.some(r => r.status === 'running') ?? false;
  const refetchRuns = runsQuery.refetch;
  useEffect(() => {
    if (!hasRunningRun) return;
    const id = setInterval(() => {
      void refetchRuns();
    }, 30_000);
    return () => clearInterval(id);
  }, [hasRunningRun, refetchRuns]);

  // When the last running run finishes, its completion publishes a routing
  // table / classifier winner. Those live in their own query caches, so
  // invalidate them on the running→terminal edge — otherwise the published
  // routing table keeps showing stale data (or "No routing table published
  // yet") until a focus refetch or manual reload.
  const prevHasRunningRun = useRef(hasRunningRun);
  useEffect(() => {
    if (prevHasRunningRun.current && !hasRunningRun) {
      void queryClient.invalidateQueries({
        queryKey: ['auto-routing', 'benchmark-routing-table'],
      });
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-config'] });
    }
    prevHasRunningRun.current = hasRunningRun;
  }, [hasRunningRun, queryClient]);

  const startRunMutation = useMutation({
    mutationFn: startBenchmarkRun,
    onSuccess: (data, variables) => {
      const kindLabel = variables.kind === 'classifier' ? 'Classifier' : 'Decider';
      if (data.enqueuedModels === 0) {
        toast.success(`All models already have results — republished from existing data`);
      } else {
        toast.success(
          `${kindLabel} benchmark started — ${data.enqueuedModels} models enqueued, ${data.skippedModels.length} skipped`
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-runs'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start benchmark run');
    },
  });

  const handleConfigSaved = useCallback(
    (next: { config: BenchmarkConfig | null }) => {
      queryClient.setQueryData(['auto-routing', 'benchmark-config'], next);
    },
    [queryClient]
  );

  const anyRunning = hasRunningRun || startRunMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Benchmarks</h2>
        <p className="text-muted-foreground text-sm">
          Benchmark configuration, runs, and published routing table.
        </p>
      </div>

      {/* Config editor */}
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
        <BenchmarkConfigEditor config={configQuery.data.config} onSaved={handleConfigSaved} />
      ) : null}

      {/* Run controls */}
      <Card className="rounded-lg">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Run Benchmark</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-4 pt-0">
          <p className="text-muted-foreground text-xs">
            Runs are triggered manually. Models with existing results are skipped unless "Re-run
            models with existing results" is checked.
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
              disabled={anyRunning}
              onClick={() => startRunMutation.mutate({ kind: 'classifier', force: forceRerun })}
            >
              <Play className="size-4" />
              Run classifier benchmark
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={anyRunning}
              onClick={() => startRunMutation.mutate({ kind: 'decider', force: forceRerun })}
            >
              <Play className="size-4" />
              Run decider benchmark
            </Button>
            {hasRunningRun ? (
              <p className="text-muted-foreground self-center text-xs">
                A benchmark is running — refreshing every 30 s
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Runs table */}
      <Card className="rounded-lg">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Benchmark Runs</CardTitle>
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
                  <TableHead>Kind</TableHead>
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

      {/* Routing table */}
      <Card className="rounded-lg">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Published Routing Table</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {routingTableQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : routingTableQuery.error ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
              {routingTableQuery.error instanceof Error
                ? routingTableQuery.error.message
                : 'Failed to load routing table'}
            </div>
          ) : routingTableQuery.data ? (
            <RoutingTableView data={routingTableQuery.data} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
