import { describe, expect, it } from '@jest/globals';
import type {
  BenchmarkConfig,
  BenchmarkRoutingTableResponse,
} from '@kilocode/auto-routing-contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  configToFormState,
  effortCoverageForModel,
  formStateToConfig,
  formatRunProgress,
  RoutingTableView,
  toBenchmarkModelOptions,
} from './BenchmarksSection';

const baseConfig: BenchmarkConfig = {
  ...formStateToConfig(configToFormState(null), null),
  classifierModels: ['classifier'],
  deciderModels: [{ id: 'selected-model' }],
};

describe('platform model selection', () => {
  it('defaults to efficient and preserves router-specific accuracy settings', () => {
    expect(formStateToConfig(configToFormState(null), null)).toMatchObject({
      router: 'efficient',
      accuracyNoiseBand: 0.05,
      frontierMinAccuracyDelta: 0,
    });
    const config: BenchmarkConfig = {
      ...baseConfig,
      router: 'frontier',
      accuracyNoiseBand: 0.02,
      frontierMinAccuracyDelta: 0.1,
    };
    expect(formStateToConfig(configToFormState(config), config)).toMatchObject({
      router: 'frontier',
      accuracyNoiseBand: 0.02,
      frontierMinAccuracyDelta: 0.1,
      minAccuracy: config.minAccuracy,
    });
  });

  it('round-trips the token profile, switch horizon, and confidence threshold', () => {
    const config: BenchmarkConfig = {
      ...baseConfig,
      productionTokenProfile: { uncachedInputTokens: 7900, cachedInputTokens: 122900 },
      switchHorizonTurns: 10,
      lowConfidenceThreshold: 0.8,
    };
    const state = configToFormState(config);
    expect(formStateToConfig({ ...state, minAccuracy: 0.9 }, config)).toMatchObject({
      productionTokenProfile: { uncachedInputTokens: 7900, cachedInputTokens: 122900 },
      switchHorizonTurns: 10,
      lowConfidenceThreshold: 0.8,
    });
  });

  it('clears optional ranking settings when their fields are empty', () => {
    const config: BenchmarkConfig = {
      ...baseConfig,
      productionTokenProfile: { uncachedInputTokens: 7900, cachedInputTokens: 122900 },
      switchHorizonTurns: 10,
      lowConfidenceThreshold: 0.8,
    };
    const state = {
      ...configToFormState(config),
      uncachedInputTokens: '',
      cachedInputTokens: ' ',
      switchHorizonTurns: '',
      lowConfidenceThreshold: '',
    };
    expect(formStateToConfig(state, config)).toMatchObject({
      productionTokenProfile: null,
      switchHorizonTurns: null,
      lowConfidenceThreshold: null,
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
    expect(coverage('~vendor/dangling-latest')).toContain('0 of 1 measured');
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
