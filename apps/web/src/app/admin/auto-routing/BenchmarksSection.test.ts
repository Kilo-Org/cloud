import { describe, expect, it } from '@jest/globals';
import {
  configToFormState,
  formatAccuracy,
  formatUsd,
  formStateToConfig,
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

describe('configToFormState', () => {
  it('yields defaults including classifierMaxP95LatencyMs "1000" when config is null', () => {
    const state = configToFormState(null);
    expect(state.classifierRepetitions).toBe(1);
    expect(state.deciderRepetitions).toBe(1);
    expect(state.classifierMaxP95LatencyMs).toBe('1000');
    expect(state.classifierModels).toBe('');
    expect(state.deciderModels).toEqual([]);
  });
});

describe('formStateToConfig round-trip', () => {
  const baseConfig = {
    classifierModels: ['model-a', 'model-b'],
    deciderModels: [{ id: 'model-c', reasoningEffort: null }],
    minAccuracy: 0.8,
    switchCostFactor: 3,
    maxConcurrency: 4,
    benchmarkUserId: 'user-123',
    classifierRepetitions: 3,
    deciderRepetitions: 2,
    classifierMaxP95LatencyMs: 500,
    updatedAt: null,
    updatedBy: null,
  };

  it('preserves classifierRepetitions, deciderRepetitions, and classifierMaxP95LatencyMs', () => {
    const state = configToFormState(baseConfig);
    expect(state.classifierRepetitions).toBe(3);
    expect(state.deciderRepetitions).toBe(2);
    expect(state.classifierMaxP95LatencyMs).toBe('500');

    const result = formStateToConfig(state, baseConfig);
    expect(result.classifierRepetitions).toBe(3);
    expect(result.deciderRepetitions).toBe(2);
    expect(result.classifierMaxP95LatencyMs).toBe(500);
  });

  it('converts empty-string classifierMaxP95LatencyMs form value to null in config', () => {
    const state = configToFormState(baseConfig);
    const stateWithEmpty = { ...state, classifierMaxP95LatencyMs: '' };
    const result = formStateToConfig(stateWithEmpty, baseConfig);
    expect(result.classifierMaxP95LatencyMs).toBeNull();
  });
});
