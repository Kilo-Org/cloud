import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARK_CONFIG, parseConfigJson } from './config';

describe('parseConfigJson', () => {
  it('returns defaults on null', () => {
    expect(parseConfigJson(null)).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });

  it('returns defaults on invalid JSON string', () => {
    expect(parseConfigJson('not valid json {{{')).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });

  it('returns defaults on schema-invalid JSON', () => {
    const invalid = JSON.stringify({ classifierModels: 'not-an-array', minAccuracy: 'bad' });
    expect(parseConfigJson(invalid)).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });

  it('returns defaults on empty object', () => {
    expect(parseConfigJson('{}')).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });

  it('round-trips a valid config', () => {
    const config = {
      ...DEFAULT_BENCHMARK_CONFIG,
      classifierModels: ['some/model'],
      minAccuracy: 0.8,
      maxConcurrency: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    };
    expect(parseConfigJson(JSON.stringify(config))).toEqual(config);
  });

  it('returns defaults when classifierModels is empty array (schema violation)', () => {
    const invalid = JSON.stringify({
      ...DEFAULT_BENCHMARK_CONFIG,
      classifierModels: [],
    });
    expect(parseConfigJson(invalid)).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });
});
