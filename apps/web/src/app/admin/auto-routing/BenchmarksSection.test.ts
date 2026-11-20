import { describe, expect, it } from '@jest/globals';
import {
  BenchmarkConfigResponseSchema,
  type BenchmarkConfig,
  type BenchmarkModelSummary,
  type BenchmarkModelTotals,
  type BenchmarkRoutingTableResponse,
  type BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConfigSaveWarnings,
  configToFormState,
  effortCoverageForModel,
  formStateToConfig,
  formatRunProgress,
  BenchmarkRunsTable,
  formatTotalUsd,
  modelTotalsFromSummaries,
  resolveModelTotals,
  responseRunningRunIds,
  RoutingTableView,
  RunRouteTable,
  RunSummariesTable,
  runLeftRunningSet,
  toBenchmarkModelOptions,
} from './BenchmarksSection';
import { formatAdminTime, relativeAge, runMentionsModel } from './admin-time';

// The expanded row is the only hook-using component rendered here; the query
// result is the fixture each test sets.
const mockSummariesQuery: {
  data: { summaries: BenchmarkModelSummary[]; modelTotals?: BenchmarkModelTotals[] } | undefined;
} = { data: { summaries: [], modelTotals: [] } };

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockSummariesQuery.data, isLoading: false, error: null }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {}, setQueryData: () => {} }),
}));

// The model picker reads tRPC user preferences; the effort-coverage column
// under test does not depend on it.
jest.mock('@/components/shared/ModelCombobox', () => ({ ModelCombobox: () => null }));

const baseConfig: BenchmarkConfig = {
  ...formStateToConfig(configToFormState(null), null),
  classifierModels: ['classifier'],
  deciderModels: [{ id: 'selected-model' }],
};

describe('platform model selection', () => {
  it('defaults to efficient and round-trips the router and accuracy noise band', () => {
    expect(formStateToConfig(configToFormState(null), null)).toMatchObject({
      router: 'efficient',
      accuracyNoiseBand: 0.05,
    });
    const config: BenchmarkConfig = {
      ...baseConfig,
      router: 'frontier',
      accuracyNoiseBand: 0.02,
    };
    expect(formStateToConfig(configToFormState(config), config)).toMatchObject({
      router: 'frontier',
      accuracyNoiseBand: 0.02,
      minAccuracy: config.minAccuracy,
    });
  });

  it('round-trips the token profile, switch horizon, and min accuracy', () => {
    const config: BenchmarkConfig = {
      ...baseConfig,
      productionTokenProfile: { uncachedInputTokens: 7900, cachedInputTokens: 122900 },
      switchHorizonTurns: 10,
    };
    const state = configToFormState(config);
    expect(formStateToConfig({ ...state, minAccuracy: 0.9 }, config)).toMatchObject({
      minAccuracy: 0.9,
      productionTokenProfile: { uncachedInputTokens: 7900, cachedInputTokens: 122900 },
      switchHorizonTurns: 10,
    });
  });

  it('clears optional ranking settings when their fields are empty', () => {
    const config: BenchmarkConfig = {
      ...baseConfig,
      productionTokenProfile: { uncachedInputTokens: 7900, cachedInputTokens: 122900 },
      switchHorizonTurns: 10,
    };
    const state = {
      ...configToFormState(config),
      uncachedInputTokens: '',
      cachedInputTokens: ' ',
      switchHorizonTurns: '',
    };
    expect(formStateToConfig(state, config)).toMatchObject({
      productionTokenProfile: null,
      switchHorizonTurns: null,
    });
  });

  it('treats one empty token field as zero tokens', () => {
    const state = { ...configToFormState(baseConfig), cachedInputTokens: '122900' };
    expect(formStateToConfig(state, baseConfig).productionTokenProfile).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 122900,
    });
  });

  it('round-trips model-level selections without adding an effort', () => {
    const state = configToFormState(baseConfig);
    expect(state.deciderModels).toEqual([{ id: 'selected-model' }]);
    const result = formStateToConfig(state, baseConfig);
    expect(result.deciderModels).toEqual([{ id: 'selected-model' }]);
  });

  it('drops blank selections and trims ids', () => {
    const state = configToFormState(baseConfig);
    expect(
      formStateToConfig(
        { ...state, deciderModels: [{ id: '  selected-model  ' }, { id: ' ' }] },
        baseConfig
      ).deciderModels
    ).toEqual([{ id: 'selected-model' }]);
  });

  it('does not infer reasoning coverage from arbitrary catalog presets or missing models', () => {
    expect(effortCoverageForModel({ id: 'model', name: 'Model', variants: ['curated'] })).toBe(
      'Effort coverage unavailable'
    );
    expect(effortCoverageForModel(undefined)).toBe('Effort coverage unavailable');
    expect(effortCoverageForModel({ id: 'model', name: 'Model', reasoningVariants: [] })).toBe(
      'Default (no configurable effort) · Measurement status unavailable'
    );
    expect(
      effortCoverageForModel({
        id: 'model',
        name: 'Model',
        reasoningVariants: ['instant', 'thinking'],
      })
    ).toBe('All 2 efforts: instant, thinking · Measurement status unavailable');
  });

  it('counts measured exact efforts and shows pending/failed efforts without counting stale or other-model entries', () => {
    const result = effortCoverageForModel(
      {
        id: 'model',
        name: 'Model',
        reasoningVariants: ['none', 'low', 'medium', 'high', 'max'],
      },
      [
        { model: 'model', variant: 'none', status: 'ready' },
        { model: 'model', variant: 'low', status: 'ready' },
        { model: 'model', variant: 'medium', status: 'ready' },
        { model: 'model', variant: 'high', status: 'pending' },
        { model: 'model', variant: 'max', status: 'failed' },
        { model: 'model', variant: 'removed', status: 'ready' },
        { model: 'other', variant: 'high', status: 'ready' },
      ]
    );
    expect(result).toContain('3 of 5 measured');
    expect(result).toContain('high: pending');
    expect(result).toContain('max: failed');
    expect(result).not.toContain('removed');
  });

  it('counts the default null pair and does not invent a pending status before registry admission', () => {
    const model = { id: 'model', name: 'Model', reasoningVariants: [] };
    expect(
      effortCoverageForModel(model, [{ model: 'model', variant: null, status: 'ready' }])
    ).toContain('1 of 1 measured');
    expect(effortCoverageForModel(model, [])).toContain('default: not measured');
    expect(effortCoverageForModel(model, [])).not.toContain('pending');
  });

  it('reports an alias with the measured efforts of its resolved target', () => {
    const reasoning = (effort: 'low' | 'high') => ({ reasoning: { effort } });
    const options = toBenchmarkModelOptions([
      { id: 'vendor/model-2', name: 'Model 2', opencode: { variants: { low: reasoning('low') } } },
      {
        id: 'vendor/model-1',
        name: 'Model 1',
        opencode: { variants: { low: reasoning('low'), high: reasoning('high') } },
      },
      {
        id: '~vendor/model-latest',
        name: 'Model Latest',
        alias_target: 'vendor/model-2',
        opencode: { variants: { low: reasoning('low'), high: reasoning('high') } },
      },
      { id: '~vendor/dangling-latest', name: 'Dangling', alias_target: 'vendor/missing' },
    ]);
    const entries = [{ model: 'vendor/model-2', variant: 'low', status: 'ready' as const }];
    const coverage = (id: string) =>
      effortCoverageForModel(
        options.find(option => option.id === id),
        entries
      );
    expect(coverage('~vendor/model-latest')).toBe('All 1 efforts: low · 1 of 1 measured');
    expect(coverage('vendor/model-1')).toContain('0 of 2 measured');
    expect(coverage('~vendor/dangling-latest')).toBe('Effort coverage unavailable');
  });
});

const routingData: BenchmarkRoutingTableResponse = {
  publishedAt: '2026-06-17T00:00:00.000Z',
  table: {
    version: 'run-1',
    generatedAt: '2026-06-17T00:00:00.000Z',
    minAccuracy: 0.7,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    source: 'benchmark',
    routes: {
      'implementation/code_generation': [
        {
          model: 'same-model',
          variant: 'high',
          accuracy: 0.75,
          avgCostUsd: 0.006,
          meetsThreshold: true,
        },
        {
          model: 'same-model',
          variant: 'low',
          accuracy: 0.5,
          avgCostUsd: 0.001,
          meetsThreshold: false,
        },
      ],
    },
  },
};

describe('compact route rankings', () => {
  it('summarizes the first exact pair with independent metrics and a keyboard expansion control', () => {
    const html = renderToStaticMarkup(React.createElement(RoutingTableView, { data: routingData }));
    expect(html).toContain('First-ranked:');
    expect(html).toContain('same-model · high');
    expect(html).toContain('Accuracy 75.0%');
    expect(html).toContain('Avg cost $0.006');
    expect(html).toContain('Meets threshold');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('same-model · low');
    expect(html).not.toContain('winner');
  });

  it('keeps legacy exact effort visible and does not claim below-threshold pairs meet the threshold', () => {
    const data: BenchmarkRoutingTableResponse = {
      ...routingData,
      table: {
        ...routingData.table!,
        routes: {
          'implementation/code_generation': [
            {
              model: 'legacy',
              reasoningEffort: 'low',
              accuracy: 0.5,
              avgCostUsd: 0.001,
              meetsThreshold: false,
            },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(React.createElement(RoutingTableView, { data }));
    expect(html).toContain('legacy · low');
    expect(html).toContain('Below threshold');
  });
});

describe('config save drain', () => {
  it('parses every drain outcome the worker reports', () => {
    const parse = (drain: unknown) =>
      BenchmarkConfigResponseSchema.safeParse({
        config: null,
        policySettings: null,
        warnings: [],
        drain,
      }).success;
    // The console rejects the whole save when this schema fails, so each value
    // the worker can send has to parse here.
    for (const skipped of ['active_run', 'nothing_pending', 'timeout', 'failed', null]) {
      expect(parse({ runId: null, entryCount: 0, skipped })).toBe(true);
    }
    expect(parse({ runId: 'run-1', entryCount: 3, skipped: null })).toBe(true);
    expect(parse({ runId: null, entryCount: 0, skipped: 'unknown_reason' })).toBe(false);
  });
});

describe('config save warnings', () => {
  it('shows each warning with its kind and the worker’s next step', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfigSaveWarnings, {
        warnings: [
          {
            kind: 'registry_sync_failed',
            message: 'Platform registry sync failed (catalog 503). Save again to retry now.',
          },
          {
            kind: 'routing_table_publish_failed',
            message: 'Routing table publish failed (D1 overloaded).',
          },
        ],
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Platform registry not synced');
    expect(html).toContain('Platform registry sync failed (catalog 503). Save again to retry now.');
    expect(html).toContain('Routing table not republished');
    expect(html).toContain('Routing table publish failed (D1 overloaded).');
  });

  it('renders nothing after a clean save', () => {
    expect(renderToStaticMarkup(React.createElement(ConfigSaveWarnings, { warnings: [] }))).toBe(
      ''
    );
  });
});

describe('benchmark run progress', () => {
  const startedAt = '2026-06-15T00:00:00.000Z';
  const tenMinutesLater = Date.parse('2026-06-15T00:10:00.000Z');

  it('shows counts without a percentage when the expected total is unknown', () => {
    expect(
      formatRunProgress({ completedCases: 12, totalCases: null, failedCases: 0 }, startedAt)
    ).toEqual({ percent: null, counts: '12 / ? cases', eta: null });
  });

  it('reports the completed share, failed cases, and a finish estimate', () => {
    expect(
      formatRunProgress(
        { completedCases: 40, totalCases: 200, failedCases: 3 },
        startedAt,
        tenMinutesLater
      )
    ).toEqual({ percent: 20, counts: '40 / 200 cases · 3 failed', eta: '40 min' });
  });

  it('projects a finish time as soon as 5% is done', () => {
    expect(
      formatRunProgress(
        { completedCases: 10, totalCases: 200, failedCases: 0 },
        startedAt,
        tenMinutesLater
      )
    ).toEqual({ percent: 5, counts: '10 / 200 cases', eta: '3 h 10 min' });
  });

  it('withholds a finish estimate below 5% done and before the run has started', () => {
    expect(
      formatRunProgress(
        { completedCases: 9, totalCases: 200, failedCases: 0 },
        startedAt,
        tenMinutesLater
      ).eta
    ).toBeNull();
    expect(
      formatRunProgress(
        { completedCases: 0, totalCases: 200, failedCases: 0 },
        startedAt,
        tenMinutesLater
      )
    ).toEqual({ percent: 0, counts: '0 / 200 cases', eta: null });
    expect(
      formatRunProgress(
        { completedCases: 50, totalCases: 100, failedCases: 0 },
        startedAt,
        Date.parse('2026-06-14T23:00:00.000Z')
      ).eta
    ).toBeNull();
  });

  it('clamps a run whose completed cases already cover the expected total', () => {
    expect(
      formatRunProgress(
        { completedCases: 200, totalCases: 200, failedCases: 0 },
        startedAt,
        tenMinutesLater
      )
    ).toEqual({ percent: 100, counts: '200 / 200 cases', eta: null });
    expect(
      formatRunProgress(
        { completedCases: 225, totalCases: 200, failedCases: 0 },
        startedAt,
        tenMinutesLater
      )
    ).toEqual({ percent: 100, counts: '225 / 200 cases', eta: null });
  });

  it('rounds a sub-minute finish estimate instead of reporting zero', () => {
    expect(
      formatRunProgress(
        { completedCases: 199, totalCases: 200, failedCases: 0 },
        startedAt,
        Date.parse('2026-06-15T00:00:30.000Z')
      ).eta
    ).toBe('<1 min');
  });
});

describe('run cost totals', () => {
  it('renders a page-sized total at two decimals but keeps a sub-cent total readable', () => {
    expect(formatTotalUsd(null)).toBe('—');
    expect(formatTotalUsd(0)).toBe('$0');
    expect(formatTotalUsd(12.3456)).toBe('$12.35');
    expect(formatTotalUsd(0.004321)).toBe('$0.004321');
    // Below the sixth decimal a real cost must never read as free.
    expect(formatTotalUsd(0.0000004)).toBe('<$0.000001');
  });
});

describe('per-model totals from route rows', () => {
  /**
   * One route row. `costedCases` defaults to every case, the ordinary shape of
   * a route whose cases all reported a cost; pass a smaller count (or null for
   * a row written before the count existed) to model a partially priced route.
   */
  const summary = (
    model: string,
    routeKey: string,
    accuracy: number,
    avgCostUsd: number | null,
    cases: number,
    errors = 0,
    costedCases: number | null = avgCostUsd === null ? 0 : cases
  ): BenchmarkModelSummary => ({
    model,
    variant: null,
    routeKey: routeKey as BenchmarkModelSummary['routeKey'],
    accuracy,
    avgCostUsd,
    avgLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 120,
    cases,
    costedCases,
    errors,
    timeouts: 0,
    routeAccuracy: null,
    avgInputTokens: null,
    avgCachedInputTokens: null,
    avgOutputTokens: null,
    avgReasoningTokens: null,
  });

  it('sums the routes of one model into a case-weighted accuracy and a total cost', () => {
    const totals = modelTotalsFromSummaries([
      summary('vendor/alpha', 'debugging/bug_fixing', 1, 0.02, 10, 1),
      summary('vendor/alpha', 'implementation/code_generation', 0.5, 0.04, 30),
    ]);
    expect(totals).toHaveLength(1);
    const [alpha] = totals;
    // 0.25 weighted accuracy over 40 cases, not the mean of the two route rates.
    expect(alpha.accuracy).toBeCloseTo(0.625, 6);
    expect(alpha.cases).toBe(40);
    expect(alpha.errors).toBe(1);
    // 10*0.02 + 30*0.04 = 1.4 total; 1.4/40 per case.
    expect(alpha.totalCostUsd).toBeCloseTo(1.4, 6);
    expect(alpha.costPerCaseUsd).toBeCloseTo(0.035, 6);
    expect(alpha.uncostedCases).toBe(0);
  });

  it('leaves uncosted cases out of the total instead of charging them the costed rate', () => {
    // 10 costed cases at $0.10 = $1, plus 30 cases whose cost is unknown.
    const [alpha] = modelTotalsFromSummaries([
      summary('vendor/alpha', 'debugging/bug_fixing', 1, 0.1, 10),
      summary('vendor/alpha', 'implementation/code_generation', 1, null, 30),
    ]);

    // Extrapolating would report $4; the real total is the $1 that was measured.
    expect(alpha.totalCostUsd).toBeCloseTo(1, 8);
    expect(alpha.costPerCaseUsd).toBeCloseTo(0.1, 8);
    expect(alpha.uncostedCases).toBe(30);
    // The cases still count for accuracy: they were measured, just not priced.
    expect(alpha.cases).toBe(40);
    expect(alpha.accuracy).toBe(1);
  });

  it('charges a partially costed route only for the cases it priced', () => {
    // One route: 40 cases, only 10 of which reported a cost, at $0.10 each.
    const [alpha] = modelTotalsFromSummaries([
      summary('vendor/alpha', 'debugging/bug_fixing', 1, 0.1, 40, 0, 10),
    ]);

    // Multiplying the route's mean by `cases` would report $4.00 with no note.
    expect(alpha.totalCostUsd).toBeCloseTo(1, 8);
    expect(alpha.costPerCaseUsd).toBeCloseTo(0.1, 8);
    expect(alpha.uncostedCases).toBe(30);
    expect(alpha.cases).toBe(40);
    expect(alpha.accuracy).toBe(1);
  });

  it('leaves the cost unknown when a route predates the costed count', () => {
    // Without the count a route cannot be split into priced and unpriced cases,
    // so neither its total nor its mean is guessed.
    const [alpha] = modelTotalsFromSummaries([
      summary('vendor/alpha', 'debugging/bug_fixing', 1, 0.1, 40, 0, null),
    ]);

    expect(alpha.totalCostUsd).toBeNull();
    expect(alpha.costPerCaseUsd).toBeNull();
    expect(alpha.uncostedCases).toBe(40);
    expect(alpha.cases).toBe(40);
  });

  it('keeps a genuine zero cost as zero rather than unknown', () => {
    const [free] = modelTotalsFromSummaries([
      summary('vendor/free', 'debugging/bug_fixing', 1, 0, 12),
    ]);

    expect(free.totalCostUsd).toBe(0);
    expect(free.costPerCaseUsd).toBe(0);
    expect(free.uncostedCases).toBe(0);
  });

  it('keeps a pair with no reported cost null rather than zero', () => {
    const [beta] = modelTotalsFromSummaries([
      summary('vendor/beta', 'debugging/bug_fixing', 0.8, null, 5),
    ]);
    expect(beta.totalCostUsd).toBeNull();
    expect(beta.costPerCaseUsd).toBeNull();
    expect(beta.uncostedCases).toBe(5);
    expect(beta.accuracy).toBe(0.8);
  });

  it('orders the most accurate pair first', () => {
    const totals = modelTotalsFromSummaries([
      summary('vendor/low', 'debugging/bug_fixing', 0.4, 0.01, 10),
      summary('vendor/high', 'debugging/bug_fixing', 0.9, 0.01, 10),
    ]);
    expect(totals.map(t => t.model)).toEqual(['vendor/high', 'vendor/low']);
  });

  it('treats an empty worker aggregate as absent instead of hiding the route rows', () => {
    const rows = [summary('vendor/alpha', 'debugging/bug_fixing', 0.8, 0.01, 5)];
    const fromWorker: BenchmarkModelTotals[] = [
      {
        model: 'vendor/zeta',
        variant: null,
        accuracy: 0.9,
        routeAccuracy: null,
        costPerCaseUsd: null,
        totalCostUsd: null,
        cases: 2,
        uncostedCases: 2,
        errors: 0,
        timeouts: 0,
      },
    ];

    // Absent and present-but-empty both fall back to folding the route rows.
    expect(resolveModelTotals(rows, undefined).map(t => t.model)).toEqual(['vendor/alpha']);
    expect(resolveModelTotals(rows, []).map(t => t.model)).toEqual(['vendor/alpha']);
    // A non-empty aggregate is the worker's own answer and wins.
    expect(resolveModelTotals(rows, fromWorker)).toEqual(fromWorker);
    // Nothing measured either way stays empty.
    expect(resolveModelTotals([], [])).toEqual([]);
  });
});

describe('readable admin times', () => {
  const iso = '2026-11-20T14:32:00.000Z';

  it('shows the local time with the exact ISO value kept for a tooltip', () => {
    const time = formatAdminTime(iso, Date.parse(iso) + 3 * 60_000);
    expect(time.iso).toBe(iso);
    expect(time.local).not.toBe(iso);
    expect(time.relative).toBe('3 min ago');
  });

  it('degrades to the raw value instead of crashing on an unparseable date', () => {
    expect(formatAdminTime('not-a-date')).toEqual({
      local: 'not-a-date',
      iso: 'not-a-date',
      relative: null,
    });
  });

  it('scales the relative age from just-now to weeks', () => {
    const now = Date.parse(iso);
    expect(relativeAge(now - 10_000, now)).toBe('just now');
    expect(relativeAge(now - 90 * 60_000, now)).toBe('1 h ago');
    expect(relativeAge(now - 3 * 86_400_000, now)).toBe('3 d ago');
    expect(relativeAge(now - 15 * 86_400_000, now)).toBe('2 w ago');
    // A clock skew never renders a negative age.
    expect(relativeAge(now + 5 * 60_000, now)).toBe('in 5 min');
  });
});

describe('find a model', () => {
  it('matches a case-insensitive substring of any enqueued model id', () => {
    const run = { models: ['anthropic/claude-sonnet-4.6', 'google/gemini-2.5-flash'] };
    expect(runMentionsModel(run, 'claude')).toBe(true);
    expect(runMentionsModel(run, 'CLAUDE')).toBe(true);
    expect(runMentionsModel(run, '  gemini ')).toBe(true);
    expect(runMentionsModel(run, 'openai')).toBe(false);
  });

  it('shows every run when the query is blank', () => {
    expect(runMentionsModel({ models: [] }, '')).toBe(true);
    expect(runMentionsModel({}, '   ')).toBe(true);
  });
});

describe('runs table cost column', () => {
  const model = 'vendor/alpha-that-is-long-enough-to-truncate-on-a-narrow-column';
  const completedRun: BenchmarkRun = {
    id: 'decider-1',
    router: 'efficient',
    kind: 'decider',
    purpose: 'platform',
    status: 'completed',
    startedAt: '2026-11-20T10:00:00.000Z',
    completedAt: '2026-11-20T10:30:00.000Z',
    error: null,
    totals: { totalCostUsd: 0.4321, measuredCases: 60, erroredCases: 3 },
    models: [model, 'vendor/beta'],
  };
  const failedRun: BenchmarkRun = {
    ...completedRun,
    id: 'decider-2',
    status: 'failed',
    completedAt: null,
    error: 'lane dead-lettered: provider returned 503 on every retry of this case',
    totals: { totalCostUsd: null, measuredCases: 4, erroredCases: 4 },
    models: ['vendor/beta'],
  };

  function render(runs: BenchmarkRun[], matchedIds: ReadonlySet<string> | null = null) {
    return renderToStaticMarkup(
      React.createElement(
        'table',
        null,
        React.createElement(
          'tbody',
          null,
          React.createElement(BenchmarkRunsTable, {
            runs,
            router: 'efficient',
            matchedIds,
          })
        )
      )
    );
  }

  it('shows each run’s cost with its measured and errored case counts', () => {
    const html = render([completedRun]);
    expect(html).toContain('$0.43');
    expect(html).toContain('60 cases · 3 errored');
    // Readable local time with the exact ISO value kept for the tooltip.
    expect(html).toContain('title="2026-11-20T10:00:00.000Z"');
  });

  it('keeps an unknown run cost as a dash and wraps the full error text', () => {
    const html = render([failedRun]);
    expect(html).toContain('4 cases · 4 errored');
    // A run whose cases reported no cost shows a dash, never a fake $0.
    expect(html).not.toContain('$0');
    expect(html).toContain('lane dead-lettered');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain(`title="lane dead-lettered`);
  });

  it('hides a run the model filter rules out and says so when none match', () => {
    const onlyCompleted = render([completedRun], new Set(['decider-1']));
    expect(onlyCompleted).toContain('vendor/alpha');
    expect(onlyCompleted).not.toContain('lane dead-lettered');

    const none = render([completedRun], new Set(['some-other-run']));
    expect(none).toContain('No run of this list measured that model');
  });

  it('says the page cannot answer when no run reports its models', () => {
    const withoutModels: BenchmarkRun[] = [{ ...completedRun, models: undefined }];

    const html = render(withoutModels, new Set(['some-other-run']));

    expect(html).not.toContain('No run of this list measured that model');
    expect(html).toContain('reports its models yet');
  });
});

describe('expanded run summaries', () => {
  const run: BenchmarkRun = {
    id: 'decider-1',
    router: 'efficient',
    kind: 'decider',
    purpose: 'platform',
    status: 'completed',
    startedAt: '2026-11-20T10:00:00.000Z',
    completedAt: '2026-11-20T10:30:00.000Z',
    error: null,
    totals: { totalCostUsd: 0.43, measuredCases: 60, erroredCases: 3 },
    models: ['vendor/alpha'],
  };
  const summary: BenchmarkModelSummary = {
    model: 'vendor/alpha',
    variant: null,
    routeKey: 'debugging/bug_fixing' as BenchmarkModelSummary['routeKey'],
    accuracy: 0.75,
    avgCostUsd: 0.02,
    avgLatencyMs: 210,
    p50LatencyMs: 180,
    p95LatencyMs: 640,
    cases: 3,
    errors: 1,
    timeouts: 7,
    routeAccuracy: null,
    avgInputTokens: null,
    avgCachedInputTokens: null,
    avgOutputTokens: null,
    avgReasoningTokens: null,
  };

  function renderExpanded() {
    return renderToStaticMarkup(
      React.createElement(
        'table',
        null,
        React.createElement(
          'tbody',
          null,
          React.createElement(RunSummariesTable, {
            run,
            router: 'efficient',
            id: 'run-summaries-1',
          })
        )
      )
    );
  }

  it('keeps the latency tail and timeout counts in the per-route detail', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        'table',
        null,
        React.createElement(
          'tbody',
          null,
          React.createElement(RunRouteTable, { summaries: [summary], isDecider: true })
        )
      )
    );

    expect(html).toContain('p50 latency');
    expect(html).toContain('p95 latency');
    expect(html).toContain('180 ms');
    expect(html).toContain('640 ms');
    // Timeouts are inspectable per pair, which errors alone do not show.
    expect(html).toContain('Timeouts');
    expect(html).toContain('>7</td>');
    // The route rows are a scroll container, so the extra columns cannot widen
    // the card at a narrow viewport.
    expect(html).toContain('overflow-x-auto');
  });

  it('shows a dash when a latency percentile is null rather than NaN', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        'table',
        null,
        React.createElement(
          'tbody',
          null,
          React.createElement(RunRouteTable, {
            summaries: [{ ...summary, p50LatencyMs: null, p95LatencyMs: null }],
            isDecider: true,
          })
        )
      )
    );

    expect(html).not.toContain('NaN');
    expect(html).toContain('—');
  });

  it('shows the route rows when the worker sends an empty model aggregate', () => {
    // A classifier run whose models were all carried finalizes with `summaries`
    // but no case rows, so the aggregate is present and empty.
    mockSummariesQuery.data = { summaries: [summary], modelTotals: [] };

    const html = renderExpanded();

    expect(html).not.toContain('No summaries');
    expect(html).toContain('vendor/alpha');
    expect(html).toContain('75.0%');
  });

  it('states how many cases the total leaves out rather than pricing them', () => {
    mockSummariesQuery.data = {
      summaries: [summary],
      modelTotals: [
        {
          model: 'vendor/alpha',
          variant: null,
          accuracy: 1,
          routeAccuracy: null,
          costPerCaseUsd: 0.1,
          totalCostUsd: 1,
          cases: 40,
          uncostedCases: 30,
          errors: 0,
          timeouts: 0,
        },
      ],
    };

    const html = renderExpanded();

    // The measured $1 stands, and the 30 unpriced cases are named apart from it
    // instead of being charged at the costed rate.
    expect(html).toContain('$1.00');
    expect(html).toContain('30 uncosted');
  });

  it('shows no uncosted note when every case reported a cost', () => {
    mockSummariesQuery.data = {
      summaries: [summary],
      modelTotals: [
        {
          model: 'vendor/alpha',
          variant: null,
          accuracy: 1,
          routeAccuracy: null,
          costPerCaseUsd: 0,
          totalCostUsd: 0,
          cases: 12,
          uncostedCases: 0,
          errors: 0,
          timeouts: 0,
        },
      ],
    };

    const html = renderExpanded();

    // A genuine zero total renders as $0 (not a dash), and nothing was left out
    // so there is no note.
    expect(html).toContain('>$0<');
    expect(html).not.toContain('uncosted');
  });

  it('prefers the worker aggregate over folding the route rows', () => {
    mockSummariesQuery.data = {
      summaries: [summary],
      modelTotals: [
        {
          model: 'vendor/zeta',
          variant: 'high',
          accuracy: 0.9,
          routeAccuracy: null,
          costPerCaseUsd: 0.01,
          totalCostUsd: 1.5,
          cases: 150,
          uncostedCases: 0,
          errors: 2,
          timeouts: 1,
        },
      ],
    };

    const html = renderExpanded();

    expect(html).toContain('vendor/zeta');
    expect(html).toContain('$1.50');
    expect(html).toContain('150');
  });
});

describe('benchmark run completion refresh', () => {
  it('refreshes when one run ends while another of the router keeps running', () => {
    expect(runLeftRunningSet(['user-a', 'user-b'], ['user-b'])).toBe(true);
    expect(runLeftRunningSet(['user-a'], [])).toBe(true);
  });

  it('does not refresh when runs only start or stay running', () => {
    expect(runLeftRunningSet(['user-a'], ['user-a', 'user-b'])).toBe(false);
    expect(runLeftRunningSet(['user-a', 'user-b'], ['user-b', 'user-a'])).toBe(false);
    expect(runLeftRunningSet([], [])).toBe(false);
  });

  it("tracks the worker's router-wide running ids and falls back to the listed runs", () => {
    const run = {
      router: 'efficient' as const,
      kind: 'decider' as const,
      purpose: 'user' as const,
      startedAt: '2026-06-15T00:00:00.000Z',
      completedAt: null,
      error: null,
    };
    const runs = [
      { ...run, id: 'listed-running', status: 'running' as const },
      { ...run, id: 'listed-done', status: 'completed' as const },
    ];
    expect(responseRunningRunIds({ runs, runningRunIds: ['hidden-by-filter'] })).toEqual([
      'hidden-by-filter',
    ]);
    expect(responseRunningRunIds({ runs })).toEqual(['listed-running']);
  });
});
