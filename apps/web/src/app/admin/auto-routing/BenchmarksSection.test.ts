import { describe, expect, it } from '@jest/globals';
import type {
  BenchmarkConfig,
  BenchmarkRoutingTableResponse,
} from '@kilocode/auto-routing-contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  configToFormState,
  effectiveDeciderModels,
  effortCoverageForModel,
  formStateToConfig,
  RoutingTableView,
} from './BenchmarksSection';

const baseConfig: BenchmarkConfig = {
  ...formStateToConfig(configToFormState(null), null),
  classifierModels: ['classifier'],
  deciderModels: [{ id: 'manual' }, { id: 'auto' }],
  manualDeciderModels: [{ id: 'manual' }],
  autoDeciderModels: [
    { id: 'auto', avgAttemptCostUsd: 21 },
    { id: 'excluded', avgAttemptCostUsd: 18 },
  ],
  excludedAutoDeciderModels: ['excluded'],
};

describe('platform model selection', () => {
  it('round-trips model-level selections without adding an effort', () => {
    const state = configToFormState(baseConfig);
    expect(state.deciderModels).toEqual([{ id: 'manual' }]);
    const result = formStateToConfig(state, baseConfig);
    expect(result.manualDeciderModels).toEqual([{ id: 'manual' }]);
    expect(result.deciderModels).toEqual([{ id: 'manual' }, { id: 'auto' }]);
    expect(result.autoDeciderModels).toEqual(baseConfig.autoDeciderModels);
    expect(result.excludedAutoDeciderModels).toEqual(['excluded']);
  });

  it('drops blank selections, trims ids, and preserves manual precedence over auto exclusions', () => {
    expect(
      effectiveDeciderModels({
        manualDeciderModels: [{ id: '  manual  ' }, { id: 'duplicate' }, { id: ' ' }],
        autoDeciderModels: [
          { id: 'duplicate', avgAttemptCostUsd: 20 },
          { id: 'included', avgAttemptCostUsd: 22 },
          { id: 'excluded', avgAttemptCostUsd: 23 },
        ],
        excludedAutoDeciderModels: ['duplicate', 'excluded'],
      })
    ).toEqual([{ id: 'manual' }, { id: 'duplicate' }, { id: 'included' }]);
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
