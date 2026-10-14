import { describe, expect, it, vi } from 'vitest';
import {
  estimateRequestCostUsd,
  type CandidatePricing,
  type RankedCandidate,
} from '@kilocode/auto-routing-contracts';
import {
  ScreeningCatalogSchema,
  ScreenResumeSchema,
  restoreScreenMeasurements,
  recordScreenModelCost,
  sampleScreenCases,
  screenCandidateJobs,
  screenMetrics,
  screenRouteComparison,
  screenRecommendation,
  screenVariants,
  selectScreenCandidates,
  type ScreenModelSpend,
  type ScreenMeasurement,
} from '../scripts/screen-candidates';
import type { OfflineSweep } from './scoreboard/schema';
import { requestDirectSweepCompletion, selectSweepCases } from './scoreboard/sweep';

const pricing: CandidatePricing = {
  promptUsdPerToken: 0.000001,
  completionUsdPerToken: 0.000002,
  cacheReadUsdPerToken: 0.0000001,
};
const catalogModel = {
  id: 'fixture/new',
  architecture: { output_modalities: ['text'] },
  supported_parameters: ['tools'],
  pricing: { prompt: '0.000001', completion: '0.000002' },
};
const result: OfflineSweep['pairs'][number]['results'][number] = {
  caseId: 'fixture-case',
  rep: 0,
  routeKey: 'implementation/feature_development',
  split: 'train',
  score: 1,
  costUsd: 0.001,
  graderCostUsd: 0,
  latencyMs: 100,
  ttftMs: 10,
  error: null,
  output: 'answer',
};
const incumbent: RankedCandidate = {
  model: 'fixture/current',
  variant: null,
  accuracy: 1,
  cases: 4,
  avgCostUsd: 1,
  p50LatencyMs: 1_000,
  p50TtftMs: 100,
  meetsThreshold: true,
  pricing,
};

function comparison(overrides: Partial<Parameters<typeof screenRouteComparison>[0]> = {}) {
  return screenRouteComparison({
    model: 'fixture/new',
    variant: null,
    metrics: screenMetrics(
      Array.from({ length: 4 }, () => result),
      pricing,
      null
    ),
    expectedCases: 4,
    incumbent,
    pricing,
    incumbentPricing: pricing,
    profile: null,
    minAccuracy: 0.9,
    ...overrides,
  });
}

describe('candidate screening', () => {
  it('filters current models, unsupported output/tools, virtual and unknown or excessive prices', () => {
    const catalog = ScreeningCatalogSchema.parse({
      data: [
        catalogModel,
        { ...catalogModel, id: 'fixture/current' },
        { ...catalogModel, id: 'fixture/no-tools', supported_parameters: ['temperature'] },
        { ...catalogModel, id: 'fixture/image', architecture: { output_modalities: ['image'] } },
        { ...catalogModel, id: 'fixture/virtual', pricing: { prompt: '-1', completion: '-1' } },
        {
          ...catalogModel,
          id: 'fixture/variable',
          pricing: { prompt: 'variable', completion: '0' },
        },
        {
          ...catalogModel,
          id: 'fixture/unknown-completion',
          pricing: { prompt: '0', completion: '' },
        },
        { ...catalogModel, id: 'fixture/auto', autoRouting: { models: ['fixture/new'] } },
        { ...catalogModel, id: 'fixture/at-cap', pricing: { prompt: '0.000003', completion: '0' } },
        { ...catalogModel, id: 'fixture/free', pricing: { prompt: '0', completion: '0' } },
      ],
    });
    expect(
      selectScreenCandidates(catalog, [{ model: 'fixture/current', variant: 'high' }], 3).map(
        model => model.id
      )
    ).toEqual(['fixture/free', 'fixture/new']);
  });

  it('keeps only the cheapest prompt-priced models with a deterministic tie break', () => {
    const catalog = ScreeningCatalogSchema.parse({ data: [
      { ...catalogModel, id: 'fixture/expensive', pricing: { prompt: '0.000002', completion: '0' } },
      { ...catalogModel, id: 'fixture/b' },
      { ...catalogModel, id: 'fixture/free', pricing: { prompt: '0', completion: '0' } },
      { ...catalogModel, id: 'fixture/a' },
    ] });
    expect(selectScreenCandidates(catalog, [], 3, 3).map(model => model.id))
      .toEqual(['fixture/free', 'fixture/a', 'fixture/b']);
    expect(selectScreenCandidates(catalog, [], 3)).toHaveLength(4);
  });

  it('schedules one case per model per pass across all variants', () => {
    const cases = selectSweepCases().slice(0, 2);
    const pairs = [
      { model: 'fixture/a', variant: null },
      { model: 'fixture/a', variant: 'high' },
      { model: 'fixture/b', variant: null },
      { model: 'fixture/b', variant: 'high' },
      { model: 'fixture/c', variant: null },
    ];
    const jobs = [...screenCandidateJobs(pairs, cases)];
    expect(jobs.map(job => job.pairIndex)).toEqual([0, 2, 4, 1, 3, 4, 0, 2, 1, 3]);
    expect(jobs.slice(0, 3).map(job => pairs[job.pairIndex].model))
      .toEqual(['fixture/a', 'fixture/b', 'fixture/c']);
    for (const [index] of pairs.entries()) {
      expect(jobs.filter(job => job.pairIndex === index).map(job => job.benchCase.id))
        .toEqual(cases.map(benchCase => benchCase.id));
    }
    expect([...screenCandidateJobs([], cases)]).toEqual([]);
  });

  it('restores existing report results by exact pair and skips only completed requests', () => {
    const cases = selectSweepCases().slice(0, 1);
    const benchCase = cases[0];
    const savedResult = { ...result, caseId: benchCase.id,
      routeKey: `${benchCase.taskType}/${benchCase.subtaskType}` };
    const previous = ScreenResumeSchema.parse({
      startedAt: '2026-10-14T00:00:00.000Z', suite: 'efficient', tableVersion: 'fixture-table',
      productionTokenProfile: null, casesPerRoute: 4,
      costUsd: 0.12, graderCostUsd: 0.01, estimatedCostUsd: 0.02,
      sampledCases: [{ id: benchCase.id, routeKey: savedResult.routeKey }],
      models: [{ model: 'fixture/new', costUnknown: false, estimatedCostUsd: 0.02, variants: [
        { variant: null, results: [savedResult] }, { variant: 'high', results: [] },
      ] }],
    });
    const measurements: ScreenMeasurement[] = [
      { model: 'fixture/new', variant: null, results: [] },
      { model: 'fixture/new', variant: 'high', results: [] },
    ];
    const identity = { suite: 'efficient' as const, casesPerRoute: 4,
      tableVersion: 'fixture-table', profile: null };
    restoreScreenMeasurements(previous, measurements, cases, identity);
    expect(measurements[0].results).toEqual([savedResult]);
    expect(previous).toMatchObject({ costUsd: 0.12, graderCostUsd: 0.01, estimatedCostUsd: 0.02 });
    const pending = [...screenCandidateJobs(measurements, cases)].filter(job =>
      !measurements[job.pairIndex].results.some(row => row.caseId === job.benchCase.id));
    expect(pending.map(job => job.pairIndex)).toEqual([1]);
    expect(() => restoreScreenMeasurements(previous, measurements, cases,
      { ...identity, suite: 'frontier' })).toThrow('same suite');
    expect(() => restoreScreenMeasurements(previous, measurements, cases,
      { ...identity, tableVersion: 'other-table' })).toThrow('same suite');
    expect(() => restoreScreenMeasurements(previous, measurements, cases,
      { ...identity, profile: { uncachedInputTokens: 10, cachedInputTokens: 0 } })).toThrow('same suite');
    const duplicate = ScreenResumeSchema.parse(previous);
    duplicate.models[0].variants[0].results.push(savedResult);
    expect(() => restoreScreenMeasurements(duplicate, measurements, cases, identity))
      .toThrow('duplicate case results');
    const changedPairs: ScreenMeasurement[] = [{ model: 'fixture/other', variant: null, results: [] }];
    expect(() => restoreScreenMeasurements(previous, changedPairs, cases, identity))
      .toThrow('same candidate models');
  });

  it('waits for a reservation before sending and settles the attempt after reading its usage', async () => {
    const admitted = Promise.withResolvers<boolean>();
    const settled = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      'data: {"usage":{"cost":0.001}}\n\n' +
      'data: [DONE]\n\n'
    ));
    const request = requestDirectSweepCompletion({
      model: 'fixture/new', fragment: {}, systemPrompt: 'system', userPrompt: 'user',
      apiKey: 'fixture-key', attributionHeaders: {}, budgetAvailable: () => true, fetchImpl,
      beforeRequest: () => admitted.promise,
      onAttemptComplete: settled,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    admitted.resolve(true);
    await request;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0]).toMatchObject({ costUsd: 0.001, output: 'answer' });
  });

  it('screens default plus highest reasoning effort, preserving the full request fragment', () => {
    const model = ScreeningCatalogSchema.parse({
      data: [
        {
          ...catalogModel,
          opencode: {
            variants: {
              max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'high' },
              low: { reasoning: { enabled: true, effort: 'low' } },
              preset: { temperature: 0 },
              xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
            },
          },
        },
      ],
    }).data[0];
    expect(screenVariants(model)).toEqual([null, 'max']);
    expect(model.opencode?.variants?.max.verbosity).toBe('high');
    expect(screenVariants(ScreeningCatalogSchema.parse({ data: [catalogModel] }).data[0])).toEqual([
      null,
    ]);
  });

  it('samples identical cases per route independently of dataset order and excludes agentic routes', () => {
    for (const suite of ['efficient', 'frontier'] as const) {
      const cases = selectSweepCases(suite);
      const selected = sampleScreenCases(cases, 4);
      expect(sampleScreenCases([...cases].reverse(), 4).map(benchCase => benchCase.id)).toEqual(
        selected.map(benchCase => benchCase.id)
      );
      const counts = new Map<string, number>();
      for (const benchCase of selected) {
        expect(benchCase.taskType).not.toBe('agentic_execution');
        if (suite === 'frontier') expect(benchCase.tier).toBe('frontier');
        const route = `${benchCase.taskType}/${benchCase.subtaskType}`;
        counts.set(route, (counts.get(route) ?? 0) + 1);
      }
      expect([...counts.values()].every(count => count === 4)).toBe(true);
    }
  });

  it('reports Wilson quality, production-profile cost and actual TTFT, excluding infrastructure errors', () => {
    const profile = { uncachedInputTokens: 1_000, cachedInputTokens: 9_000 };
    const metrics = screenMetrics(
      [
        result,
        { ...result, score: 0, ttftMs: 30 },
        { ...result, score: null, error: 'grader_failed', latencyMs: 999_999, ttftMs: 999_999 },
      ],
      pricing,
      profile
    );
    expect(metrics).toMatchObject({
      cases: 2,
      pricedCases: 2,
      errors: 1,
      accuracy: 0.5,
      p50TtftMs: 20,
    });
    expect(metrics.wilsonLowerBound).toBeLessThan(0.5);
    expect(metrics.estimatedRequestCostUsd).toBe(
      estimateRequestCostUsd({ avgCostUsd: 0.001, pricing }, profile)
    );
    expect(screenMetrics([{ ...result, ttftMs: null }], pricing, null).p50TtftMs).toBeNull();
  });

  it('requires one variant to beat two routes instead of combining one win per variant', () => {
    expect(
      screenRecommendation([
        { routes: [{ routeKey: 'route-a', beatsCurrentPick: true }] },
        { routes: [{ routeKey: 'route-b', beatsCurrentPick: true }] },
      ])
    ).toEqual({ beatsCurrentPickRoutes: ['route-a', 'route-b'], recommend: false });
  });

  it('recommends a single variant winning two distinct routes and ignores duplicated wins', () => {
    const oneRoute = {
      routes: [
        { routeKey: 'route-a', beatsCurrentPick: true },
        { routeKey: 'route-a', beatsCurrentPick: true },
        { routeKey: 'route-b', beatsCurrentPick: false },
      ],
    };
    expect(screenRecommendation([oneRoute]).recommend).toBe(false);
    expect(
      screenRecommendation([
        oneRoute,
        {
          routes: [
            { routeKey: 'route-b', beatsCurrentPick: true },
            { routeKey: 'route-c', beatsCurrentPick: true },
          ],
        },
      ])
    ).toEqual({ beatsCurrentPickRoutes: ['route-a', 'route-b', 'route-c'], recommend: true });
  });

  it('requires a strict eligible value improvement over a comparable current pick', () => {
    expect(comparison().beatsCurrentPick).toBe(true);
    expect(comparison({ incumbent: { ...incumbent, p50LatencyMs: null } }).beatsCurrentPick).toBe(
      false
    );
    expect(comparison({ incumbent: undefined }).beatsCurrentPick).toBe(false);
    expect(comparison({ expectedCases: 5 }).beatsCurrentPick).toBe(false);
    expect(
      comparison({
        profile: { uncachedInputTokens: 100, cachedInputTokens: 0 },
        incumbentPricing: null,
      }).beatsCurrentPick
    ).toBe(false);
    expect(
      comparison({
        metrics: screenMetrics([{ ...result, score: 0.1 }], pricing, null),
        expectedCases: 1,
      }).beatsCurrentPick
    ).toBe(false);
    expect(
      comparison({
        metrics: screenMetrics(
          [{ ...result, costUsd: null, error: 'usage_missing' }],
          pricing,
          null
        ),
        expectedCases: 1,
      }).beatsCurrentPick
    ).toBe(false);
    expect(
      comparison({
        incumbent: {
          ...incumbent,
          avgCostUsd: result.costUsd ?? 0,
          p50LatencyMs: result.latencyMs,
          p50TtftMs: result.ttftMs,
        },
      }).beatsCurrentPick
    ).toBe(false);
  });

  it('isolates missing-cost models and charges catalog token prices while other models continue', async () => {
    const stream = (usage: Record<string, number>) => new Response(
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      `data: ${JSON.stringify({ usage })}\n\n` +
      'data: [DONE]\n\n'
    );
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(stream({ prompt_tokens: 1_000, completion_tokens: 100 }))
      .mockResolvedValueOnce(stream({ cost: 0.001 }))
      .mockResolvedValueOnce(stream({ cost: 0.001 }));
    const affected: ScreenModelSpend = { costUnknown: false, estimatedCostUsd: 0 };
    const healthy: ScreenModelSpend = { costUnknown: false, estimatedCostUsd: 0 };
    const spends = new Map([['fixture/affected', affected], ['fixture/healthy', healthy]]);
    const maxUsd = 0.01;
    let costUsd = 0;
    for (const model of ['fixture/affected', 'fixture/healthy', 'fixture/affected', 'fixture/healthy']) {
      const spend = spends.get(model);
      if (!spend || spend.costUnknown || costUsd >= maxUsd) continue;
      const completion = await requestDirectSweepCompletion({
        model, fragment: {}, systemPrompt: 'system', userPrompt: 'user',
        apiKey: 'fixture-key', attributionHeaders: {},
        budgetAvailable: () => costUsd < maxUsd, fetchImpl,
      });
      costUsd += recordScreenModelCost(spend, completion, pricing, {
        systemPrompt: 'system', userPrompt: 'user', fragment: {},
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(affected.costUnknown).toBe(true);
    expect(affected.estimatedCostUsd).toBeCloseTo(0.0012);
    expect(healthy).toEqual({ costUnknown: false, estimatedCostUsd: 0 });
    expect(costUsd).toBeCloseTo(0.0032);
    expect(costUsd).toBeLessThan(maxUsd);
  });

  it.each([
    { fragment: {}, completionTokens: 8192 },
    { fragment: { max_tokens: 100 }, completionTokens: 100 },
  ])('bounds missing-token cost by prompt size and $completionTokens output tokens', ({ fragment, completionTokens }) => {
    const spend: ScreenModelSpend = { costUnknown: false, estimatedCostUsd: 0 };
    const costUsd = recordScreenModelCost(spend, {
      costUsd: null, output: 'answer', error: 'usage_missing',
    }, pricing, {
      systemPrompt: 's'.repeat(80), userPrompt: 'u'.repeat(20), fragment,
    });
    const expected = 25 * pricing.promptUsdPerToken + completionTokens * pricing.completionUsdPerToken;
    expect(costUsd).toBeCloseTo(expected);
    expect(costUsd).toBeLessThan(0.02);
    expect(spend.costUnknown).toBe(true);
    expect(spend.estimatedCostUsd).toBeCloseTo(expected);
  });

  it('uses the shared direct streaming request path and honors its budget gate', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
            'data: {"usage":{"cost":0.001}}\n\n' +
            'data: [DONE]\n\n'
        )
      );
    const input = {
      model: 'fixture/new',
      fragment: { reasoning: { effort: 'max' }, verbosity: 'high' },
      systemPrompt: 'system',
      userPrompt: 'user',
      apiKey: 'fixture-key',
      attributionHeaders: {},
      budgetAvailable: () => true,
      fetchImpl,
    };
    const completion = await requestDirectSweepCompletion(input);
    expect(completion).toMatchObject({ output: 'answer', costUsd: 0.001, error: null });
    expect(completion.ttftMs).not.toBeNull();
    const request = fetchImpl.mock.calls[0][1];
    expect(JSON.parse(typeof request?.body === 'string' ? request.body : '{}')).toEqual({
      ...input.fragment,
      model: input.model,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
      stream: true,
      usage: { include: true },
    });
    const blocked = await requestDirectSweepCompletion({ ...input, budgetAvailable: () => false });
    expect(blocked).toMatchObject({ output: null, error: 'Sweep budget exhausted before request' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
