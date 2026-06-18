import { describe, expect, it } from '@jest/globals';
import type { BenchmarkConfig } from '@kilocode/auto-routing-contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  configToFormState,
  costPerAccuracy,
  effectiveDeciderModels,
  formatCostPerAccuracy,
  formatAccuracy,
  formatUsd,
  formStateToConfig,
  RoutingTableView,
} from './BenchmarksSection';

describe('formatAccuracy', () => {
  it('formats 0.8542 as 85.4%', () => {
    expect(formatAccuracy(0.8542)).toBe('85.4%');
  });

  it('formats 1.0 as 100.0%', () => {
    expect(formatAccuracy(1.0)).toBe('100.0%');
  });

  it('formats 0 as 0.0%', () => {
    expect(formatAccuracy(0)).toBe('0.0%');
  });

  it('formats 0.5 as 50.0%', () => {
    expect(formatAccuracy(0.5)).toBe('50.0%');
  });

  it('rounds to one decimal place', () => {
    expect(formatAccuracy(0.9999)).toBe('100.0%');
    expect(formatAccuracy(0.9994)).toBe('99.9%');
  });
});

describe('formatUsd', () => {
  it('returns em dash for null', () => {
    expect(formatUsd(null)).toBe('—');
  });

  it('formats a small cost with 6 decimal places', () => {
    expect(formatUsd(0.000123)).toBe('$0.000123');
  });

  it('trims trailing zeros', () => {
    expect(formatUsd(0.1)).toBe('$0.1');
  });

  it('formats zero as $0.0', () => {
    expect(formatUsd(0)).toBe('$0.0');
  });

  it('formats a typical cost', () => {
    expect(formatUsd(0.001234)).toBe('$0.001234');
  });

  it('formats a cost that fits exactly at 6dp', () => {
    expect(formatUsd(0.000001)).toBe('$0.000001');
  });
});

describe('costPerAccuracy', () => {
  it('divides average cost by accuracy', () => {
    expect(costPerAccuracy({ avgCostUsd: 0.006, accuracy: 0.75 })).toBeCloseTo(0.008);
  });

  it('formats the value as USD', () => {
    expect(formatCostPerAccuracy({ avgCostUsd: 0.006, accuracy: 0.75 })).toBe('$0.008');
  });

  it('uses an em dash when accuracy is zero', () => {
    expect(formatCostPerAccuracy({ avgCostUsd: 0.001, accuracy: 0 })).toBe('—');
  });
});

describe('RoutingTableView', () => {
  it('renders candidates in the published serving rank order', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingTableView, {
        data: {
          publishedAt: '2026-06-17T00:00:00.000Z',
          table: {
            version: 'run-1',
            generatedAt: '2026-06-17T00:00:00.000Z',
            minAccuracy: 0.7,
            switchCostFactor: 3,
            source: 'benchmark',
            routes: {
              'implementation/code_generation': [
                {
                  model: 'threshold-meeting',
                  accuracy: 0.75,
                  avgCostUsd: 0.006,
                  meetsThreshold: true,
                  reasoningEffort: null,
                },
                {
                  model: 'below-threshold-cheaper',
                  accuracy: 0.5,
                  avgCostUsd: 0.001,
                  meetsThreshold: false,
                  reasoningEffort: null,
                },
              ],
            },
          },
        },
      })
    );

    expect(html.indexOf('threshold-meeting')).toBeLessThan(html.indexOf('below-threshold-cheaper'));
  });

  it('renders reasoning effort next to the model name', () => {
    const html = renderToStaticMarkup(
      React.createElement(RoutingTableView, {
        data: {
          publishedAt: '2026-06-17T00:00:00.000Z',
          table: {
            version: 'run-1',
            generatedAt: '2026-06-17T00:00:00.000Z',
            minAccuracy: 0.7,
            switchCostFactor: 3,
            source: 'benchmark',
            routes: {
              'implementation/code_generation': [
                {
                  model: 'openai/gpt-5',
                  accuracy: 0.8,
                  avgCostUsd: 0.006,
                  meetsThreshold: true,
                  reasoningEffort: 'high',
                },
              ],
            },
          },
        },
      })
    );

    expect(html.indexOf('Model')).toBeLessThan(html.indexOf('Reasoning effort'));
    expect(html.indexOf('Reasoning effort')).toBeLessThan(html.indexOf('Accuracy'));
    expect(html.indexOf('openai/gpt-5')).toBeLessThan(html.indexOf('high'));
    expect(html.indexOf('high')).toBeLessThan(html.indexOf('80.0%'));
  });
});

describe('configToFormState', () => {
  it('yields defaults with blank benchmark identity override fields when config is null', () => {
    const state = configToFormState(null);
    expect(state.classifierRepetitions).toBe(1);
    expect(state.deciderRepetitions).toBe(1);
    expect(state.classifierMaxP95LatencyMs).toBe('1000');
    expect(state.autoDeciderMinCostUsd).toBe(15);
    expect(state.autoDeciderMaxCostUsd).toBe(25);
    expect(state.classifierModels).toBe('');
    expect(state.deciderModels).toEqual([]);
    expect(state.autoDeciderModels).toEqual([]);
    expect(state.excludedAutoDeciderModels).toBe('');
    expect(state.maxConcurrency).toBe(100);
    expect(state.benchmarkUserId).toBe('');
    expect(state.benchmarkOrgId).toBe('');
  });
});

describe('formStateToConfig round-trip', () => {
  const baseConfig: BenchmarkConfig = {
    classifierModels: ['model-a', 'model-b'],
    deciderModels: [{ id: 'model-c', reasoningEffort: null }],
    manualDeciderModels: [{ id: 'manual-model', reasoningEffort: 'low' }],
    autoDeciderModels: [
      { id: 'auto-model', reasoningEffort: null, avgAttemptCostUsd: 21.25 },
      { id: 'excluded-auto-model', reasoningEffort: 'high', avgAttemptCostUsd: 18 },
    ],
    excludedAutoDeciderModels: ['excluded-auto-model'],
    minAccuracy: 0.8,
    switchCostFactor: 3,
    maxConcurrency: 4,
    benchmarkUserId: 'user-123',
    benchmarkOrgId: 'org-123',
    classifierRepetitions: 3,
    deciderRepetitions: 2,
    classifierMaxP95LatencyMs: 500,
    autoDeciderMinCostUsd: 12,
    autoDeciderMaxCostUsd: 24,
    updatedAt: null,
    updatedBy: null,
  };

  it('preserves repetitions, classifierMaxP95LatencyMs, and auto decider cost bounds', () => {
    const state = configToFormState(baseConfig);
    expect(state.classifierRepetitions).toBe(3);
    expect(state.deciderRepetitions).toBe(2);
    expect(state.classifierMaxP95LatencyMs).toBe('500');
    expect(state.autoDeciderMinCostUsd).toBe(12);
    expect(state.autoDeciderMaxCostUsd).toBe(24);
    expect(state.benchmarkOrgId).toBe('org-123');
    expect(state.deciderModels).toEqual([{ id: 'manual-model', reasoningEffort: 'low' }]);
    expect(state.autoDeciderModels).toEqual(baseConfig.autoDeciderModels);
    expect(state.excludedAutoDeciderModels).toBe('excluded-auto-model');

    const result = formStateToConfig(state, baseConfig);
    expect(result.classifierRepetitions).toBe(3);
    expect(result.deciderRepetitions).toBe(2);
    expect(result.classifierMaxP95LatencyMs).toBe(500);
    expect(result.autoDeciderMinCostUsd).toBe(12);
    expect(result.autoDeciderMaxCostUsd).toBe(24);
    expect(result.benchmarkOrgId).toBe('org-123');
    expect(result.manualDeciderModels).toEqual([{ id: 'manual-model', reasoningEffort: 'low' }]);
    expect(result.excludedAutoDeciderModels).toEqual(['excluded-auto-model']);
    expect(result.deciderModels).toEqual([
      { id: 'manual-model', reasoningEffort: 'low' },
      { id: 'auto-model', reasoningEffort: null },
    ]);
  });

  it('converts empty-string classifierMaxP95LatencyMs form value to null in config', () => {
    const state = configToFormState(baseConfig);
    const stateWithEmpty = { ...state, classifierMaxP95LatencyMs: '' };
    const result = formStateToConfig(stateWithEmpty, baseConfig);
    expect(result.classifierMaxP95LatencyMs).toBeNull();
  });

  it('converts blank benchmark identity override fields to null in config', () => {
    const state = configToFormState(baseConfig);
    const result = formStateToConfig(
      { ...state, benchmarkUserId: '  ', benchmarkOrgId: '  ' },
      baseConfig
    );
    expect(result.benchmarkUserId).toBeNull();
    expect(result.benchmarkOrgId).toBeNull();
  });
});

describe('effectiveDeciderModels', () => {
  it('combines manual models with non-excluded auto models and lets manual override an auto duplicate', () => {
    expect(
      effectiveDeciderModels({
        manualDeciderModels: [
          { id: 'manual/model', reasoningEffort: null },
          { id: 'auto/duplicate', reasoningEffort: 'high' },
        ],
        autoDeciderModels: [
          { id: 'auto/duplicate', reasoningEffort: null, avgAttemptCostUsd: 20 },
          { id: 'auto/included', reasoningEffort: 'low', avgAttemptCostUsd: 22 },
          { id: 'auto/excluded', reasoningEffort: null, avgAttemptCostUsd: 23 },
        ],
        excludedAutoDeciderModels: ['auto/excluded'],
      })
    ).toEqual([
      { id: 'manual/model', reasoningEffort: null },
      { id: 'auto/duplicate', reasoningEffort: 'high' },
      { id: 'auto/included', reasoningEffort: 'low' },
    ]);
  });
});
