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
  RoutingTableView,
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
