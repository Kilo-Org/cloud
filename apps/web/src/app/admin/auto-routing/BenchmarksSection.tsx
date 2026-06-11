'use client';

import {
  BenchmarkConfigResponseSchema,
  BenchmarkRunsResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkRun,
  type BenchmarkModelSummary,
} from '@kilocode/auto-routing-contracts';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Play, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import * as z from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  BenchmarkRoutingTableResponseSchema,
  type BenchmarkRoutingTableResponse,
} from './BenchmarksSection.types';

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

// ---------------------------------------------------------------------------
// API error helper (mirrors the one in AutoRoutingAdminContent.tsx)
// ---------------------------------------------------------------------------

const AdminApiErrorSchema = z.object({ error: z.string().optional() });

async function parseAdminResponse<T extends object>(
  response: Response,
  schema: z.ZodType<T>
): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsedError = AdminApiErrorSchema.safeParse(body);
    throw new Error(
      parsedError.success && parsedError.data.error
        ? parsedError.data.error
        : `Request failed: ${response.status}`
    );
  }
  return schema.parse(body);
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

async function startBenchmarkRun(kind: 'classifier' | 'decider') {
  const response = await fetch('/admin/api/auto-routing/benchmark-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
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
  chat_completions: boolean;
  responses: boolean;
  messages: boolean;
};

function configToFormState(config: BenchmarkConfig): {
  classifierModels: string;
  deciderModels: DeciderModelRow[];
  minAccuracy: number;
  maxConcurrency: number;
} {
  return {
    classifierModels: config.classifierModels.join('\n'),
    deciderModels: config.deciderModels.map(m => ({
      id: m.id,
      chat_completions: m.supportedApiKinds.includes('chat_completions'),
      responses: m.supportedApiKinds.includes('responses'),
      messages: m.supportedApiKinds.includes('messages'),
    })),
    minAccuracy: config.minAccuracy,
    maxConcurrency: config.maxConcurrency,
  };
}

function formStateToConfig(
  state: ReturnType<typeof configToFormState>,
  base: BenchmarkConfig
): BenchmarkConfig {
  const classifierModels = state.classifierModels
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const deciderModels = state.deciderModels
    .filter(row => row.id.trim().length > 0)
    .map(row => {
      const kinds: Array<'chat_completions' | 'responses' | 'messages'> = [];
      if (row.chat_completions) kinds.push('chat_completions');
      if (row.responses) kinds.push('responses');
      if (row.messages) kinds.push('messages');
      return {
        id: row.id.trim(),
        supportedApiKinds: kinds.length ? kinds : ['chat_completions' as const],
      };
    });
  return {
    classifierModels,
    deciderModels,
    minAccuracy: state.minAccuracy,
    maxConcurrency: state.maxConcurrency,
    updatedAt: base.updatedAt,
    updatedBy: base.updatedBy,
  };
}

// ---------------------------------------------------------------------------
// Config editor sub-component
// ---------------------------------------------------------------------------

function BenchmarkConfigEditor({
  config,
  defaults,
  onSaved,
}: {
  config: BenchmarkConfig;
  defaults: BenchmarkConfig;
  onSaved: (next: { config: BenchmarkConfig; defaults: BenchmarkConfig }) => void;
}) {
  const [form, setForm] = useState(() => configToFormState(config));

  // Sync when config changes from outside (initial load / after save)
  const prevConfigRef = useRef(config);
  useEffect(() => {
    if (prevConfigRef.current !== config) {
      prevConfigRef.current = config;
      setForm(configToFormState(config));
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: saveBenchmarkConfig,
    onSuccess: data => {
      onSaved(data);
      toast.success('Benchmark config saved');
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save benchmark config');
    },
  });

  const handleResetToDefaults = useCallback(() => {
    setForm(configToFormState(defaults));
  }, [defaults]);

  const handleAddDeciderRow = useCallback(() => {
    setForm(prev => ({
      ...prev,
      deciderModels: [
        ...prev.deciderModels,
        { id: '', chat_completions: true, responses: false, messages: false },
      ],
    }));
  }, []);

  const handleRemoveDeciderRow = useCallback((index: number) => {
    setForm(prev => ({
      ...prev,
      deciderModels: prev.deciderModels.filter((_, i) => i !== index),
    }));
  }, []);

  const handleDeciderRowChange = useCallback((index: number, patch: Partial<DeciderModelRow>) => {
    setForm(prev => ({
      ...prev,
      deciderModels: prev.deciderModels.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  }, []);

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
            onChange={e => setForm(prev => ({ ...prev, classifierModels: e.target.value }))}
            rows={4}
            className="font-mono text-xs"
            placeholder="openai/gpt-4o-mini"
          />
        </div>

        {/* Decider models table */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-medium">Decider models</Label>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model ID</TableHead>
                  <TableHead className="w-32 text-center">chat_completions</TableHead>
                  <TableHead className="w-24 text-center">responses</TableHead>
                  <TableHead className="w-24 text-center">messages</TableHead>
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
                    <TableCell className="py-2 text-center">
                      <Checkbox
                        checked={row.chat_completions}
                        onCheckedChange={checked =>
                          handleDeciderRowChange(index, { chat_completions: checked === true })
                        }
                        aria-label={`Model ${index + 1} supports chat_completions`}
                      />
                    </TableCell>
                    <TableCell className="py-2 text-center">
                      <Checkbox
                        checked={row.responses}
                        onCheckedChange={checked =>
                          handleDeciderRowChange(index, { responses: checked === true })
                        }
                        aria-label={`Model ${index + 1} supports responses`}
                      />
                    </TableCell>
                    <TableCell className="py-2 text-center">
                      <Checkbox
                        checked={row.messages}
                        onCheckedChange={checked =>
                          handleDeciderRowChange(index, { messages: checked === true })
                        }
                        aria-label={`Model ${index + 1} supports messages`}
                      />
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
                setForm(prev => ({ ...prev, minAccuracy: parseFloat(e.target.value) || 0 }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benchmark-max-concurrency" className="text-sm font-medium">
              Max concurrency (1–16)
            </Label>
            <Input
              id="benchmark-max-concurrency"
              type="number"
              min={1}
              max={16}
              step={1}
              value={form.maxConcurrency}
              onChange={e =>
                setForm(prev => ({ ...prev, maxConcurrency: parseInt(e.target.value, 10) || 1 }))
              }
              className="h-8 w-40 tabular-nums"
            />
          </div>
        </div>

        {/* Actions + metadata */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={handleSave} disabled={saveMutation.isPending}>
              <Save className="size-4" />
              Save config
            </Button>
            <Button type="button" variant="outline" onClick={handleResetToDefaults}>
              <RotateCcw className="size-4" />
              Reset to defaults
            </Button>
          </div>
          {config.updatedAt ? (
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

function RunSummariesTable({ run }: { run: BenchmarkRun }) {
  const isDecider = run.kind === 'decider';

  const sortedSummaries: BenchmarkModelSummary[] = isDecider
    ? [...run.summaries].sort((a, b) => {
        const tierOrder = { low: 0, medium: 1, high: 2, '*': 3 };
        const tierDiff =
          (tierOrder[a.tier as keyof typeof tierOrder] ?? 3) -
          (tierOrder[b.tier as keyof typeof tierOrder] ?? 3);
        if (tierDiff !== 0) return tierDiff;
        return b.accuracy - a.accuracy;
      })
    : run.summaries;

  if (sortedSummaries.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={8} className="text-muted-foreground h-10 text-center text-xs">
          No summaries
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      <TableRow className="bg-muted/30">
        <TableCell colSpan={8} className="px-4 py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Model</TableHead>
                {isDecider ? <TableHead className="text-xs">Tier</TableHead> : null}
                <TableHead className="text-right text-xs">Accuracy</TableHead>
                <TableHead className="text-right text-xs">Avg cost</TableHead>
                <TableHead className="text-right text-xs">Avg latency</TableHead>
                <TableHead className="text-right text-xs">p50 latency</TableHead>
                <TableHead className="text-right text-xs">Cases</TableHead>
                <TableHead className="text-right text-xs">Errors</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedSummaries.map((s, i) => (
                <TableRow key={`${s.model}-${s.tier}-${i}`}>
                  <TableCell className="max-w-56 truncate font-mono text-xs">{s.model}</TableCell>
                  {isDecider ? (
                    <TableCell className="text-xs capitalize">{s.tier}</TableCell>
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
                  <TableCell className="text-right tabular-nums text-xs">{s.cases}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{s.errors}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCell>
      </TableRow>
    </>
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
        return (
          <React.Fragment key={run.id}>
            <TableRow
              className="cursor-pointer"
              onClick={() => toggleExpand(run.id)}
              aria-expanded={expanded}
            >
              <TableCell className="w-8 py-2">
                {expanded ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
              </TableCell>
              <TableCell className="py-2 capitalize text-sm">{run.kind}</TableCell>
              <TableCell className="py-2">
                <Badge variant={statusBadgeVariant(run.status)} className="capitalize">
                  {run.status}
                </Badge>
              </TableCell>
              <TableCell className="py-2 text-xs tabular-nums">{run.startedAt}</TableCell>
              <TableCell className="py-2 text-xs tabular-nums">{run.completedAt ?? '—'}</TableCell>
              <TableCell className="py-2 text-xs text-destructive max-w-48 truncate">
                {run.error ?? ''}
              </TableCell>
            </TableRow>
            {expanded ? <RunSummariesTable run={run} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Routing table view
// ---------------------------------------------------------------------------

function RoutingTableView({ data }: { data: BenchmarkRoutingTableResponse }) {
  if (!data.table) {
    return <p className="text-muted-foreground text-sm">No routing table published yet.</p>;
  }

  const { table } = data;
  const tierEntries = [
    { tier: 'low', candidates: table.tiers.low },
    { tier: 'medium', candidates: table.tiers.medium },
    { tier: 'high', candidates: table.tiers.high },
  ] as const;

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

      {tierEntries.map(({ tier, candidates }) => (
        <div key={tier}>
          <p className="text-sm font-medium capitalize mb-1.5">{tier} tier</p>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Accuracy</TableHead>
                  <TableHead className="text-right">Avg cost</TableHead>
                  <TableHead>Threshold</TableHead>
                  <TableHead>API kinds</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c, i) => (
                  <TableRow key={`${tier}-${c.model}-${i}`}>
                    <TableCell className="max-w-56 truncate font-mono text-xs">{c.model}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {formatAccuracy(c.accuracy)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {formatUsd(c.avgCostUsd)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.meetsThreshold ? 'default' : 'secondary'}>
                        {c.meetsThreshold ? 'meets' : 'below'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="flex flex-wrap gap-1">
                        {c.supportedApiKinds.map(kind => (
                          <Badge key={kind} variant="outline" className="font-mono text-xs px-1">
                            {kind}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main exported section component
// ---------------------------------------------------------------------------

export function BenchmarksSection() {
  const queryClient = useQueryClient();

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

  const startRunMutation = useMutation({
    mutationFn: startBenchmarkRun,
    onSuccess: (data, kind) => {
      toast.success(
        `${kind === 'classifier' ? 'Classifier' : 'Decider'} benchmark started — ${data.enqueuedModels} models enqueued`
      );
      void queryClient.invalidateQueries({ queryKey: ['auto-routing', 'benchmark-runs'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start benchmark run');
    },
  });

  const handleConfigSaved = useCallback(
    (next: { config: BenchmarkConfig; defaults: BenchmarkConfig }) => {
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
        <BenchmarkConfigEditor
          config={configQuery.data.config}
          defaults={configQuery.data.defaults}
          onSaved={handleConfigSaved}
        />
      ) : null}

      {/* Run controls */}
      <Card className="rounded-lg">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Run Benchmark</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-4 pt-0">
          <Button
            type="button"
            variant="outline"
            disabled={anyRunning}
            onClick={() => startRunMutation.mutate('classifier')}
          >
            <Play className="size-4" />
            Run classifier benchmark
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={anyRunning}
            onClick={() => startRunMutation.mutate('decider')}
          >
            <Play className="size-4" />
            Run decider benchmark
          </Button>
          {hasRunningRun ? (
            <p className="text-muted-foreground self-center text-xs">
              A benchmark is running — refreshing every 30 s
            </p>
          ) : null}
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
