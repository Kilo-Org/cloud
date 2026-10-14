import { describe, expect, it } from 'vitest';
import { OfflineSweepSchema, type OfflineSweep } from './schema';
import { summarizeSweep } from './sweep';

type SweepResult = OfflineSweep['pairs'][number]['results'][number];
const result: SweepResult = {
  caseId: 'fixture-case',
  rep: 0,
  routeKey: 'implementation/code_generation',
  split: 'heldOut',
  score: 1,
  costUsd: 0.02,
  graderCostUsd: 0,
  latencyMs: 100,
  error: null,
};
const pair = { model: 'fixture/model', variant: null };

describe('summarizeSweep', () => {
  it.each([
    'OpenRouter transport or body read failed',
    'OpenRouter returned HTTP 429',
    'OpenRouter returned HTTP 503',
    'grader_failed',
    'Decider judge failed',
    'OpenRouter response is missing valid usage.cost',
    'OpenRouter response is missing valid usage',
  ])('excludes legacy infrastructure failure %s from graded metrics', error => {
    const summaries = summarizeSweep([
      {
        ...pair,
        results: [result, { ...result, caseId: 'infra-case', score: 0, latencyMs: 10000, error }],
      },
    ]);
    expect(summaries).toEqual([
      {
        ...pair,
        routeKey: result.routeKey,
        split: result.split,
        accuracy: 1,
        cases: 1,
        errors: 1,
        avgCostUsd: 0.02,
        p50LatencyMs: 100,
      },
    ]);
  });

  it('includes a graded answer with missing usage in accuracy and latency, but not the cost mean', () => {
    const summaries = summarizeSweep([
      {
        ...pair,
        results: [
          result,
          {
            ...result,
            caseId: 'usage-missing',
            output: 'A graded answer',
            score: 0.5,
            costUsd: null,
            latencyMs: 300,
            error: 'usage_missing',
          },
        ],
      },
    ]);
    expect(summaries[0]).toMatchObject({
      accuracy: 0.75,
      cases: 2,
      errors: 0,
      avgCostUsd: 0.02,
      p50LatencyMs: 200,
    });
  });

  it('counts an empty answer as a real model failure even without reported usage', () => {
    const summaries = summarizeSweep([
      {
        ...pair,
        results: [
          result,
          {
            ...result,
            caseId: 'empty-answer',
            output: '',
            score: 0,
            costUsd: null,
            error: 'OpenRouter response is missing answer content',
          },
        ],
      },
    ]);
    expect(summaries[0]).toMatchObject({ accuracy: 0.5, cases: 2, errors: 0, avgCostUsd: 0.02 });
  });

  it('retains an all-infrastructure route as unavailable with its excluded count', () => {
    const summaries = summarizeSweep([
      { ...pair, results: [{ ...result, score: null, error: 'grader_failed' }] },
    ]);
    expect(summaries[0]).toMatchObject({
      accuracy: null,
      cases: 0,
      errors: 1,
      avgCostUsd: null,
      p50LatencyMs: null,
    });
  });

  it('keeps unknown cost unavailable rather than inventing a free request', () => {
    const summaries = summarizeSweep([
      { ...pair, results: [{ ...result, costUsd: null, error: 'usage_missing' }] },
    ]);
    expect(summaries[0]).toMatchObject({ accuracy: 1, cases: 1, errors: 0, avgCostUsd: null });
  });

  it('keeps pair, route and split summaries separate without mutating stored results', () => {
    const pairs: OfflineSweep['pairs'] = [
      { ...pair, results: [result, { ...result, split: 'train', score: 0 }] },
      { ...pair, variant: 'high', results: [{ ...result, routeKey: 'debugging/bug_fixing' }] },
    ];
    const original = structuredClone(pairs);
    const summaries = summarizeSweep(pairs);
    expect(summaries).toHaveLength(3);
    expect(summaries.map(summary => summary.accuracy)).toEqual([1, 0, 1]);
    expect(pairs).toEqual(original);
  });

  it('round-trips null grader scores and missing legacy scores through the resume schema', () => {
    const sweep: OfflineSweep = {
      startedAt: '2026-01-01T00:00:00.000Z',
      truncated: false,
      costUsd: 0.02,
      graderCostUsd: 0,
      pairs: [{ ...pair, results: [{ ...result, score: null, error: 'grader_failed' }] }],
      summaries: [],
    };
    sweep.summaries = summarizeSweep(sweep.pairs);
    expect(OfflineSweepSchema.parse(JSON.parse(JSON.stringify(sweep)))).toEqual(sweep);
    const { score, ...withoutScore } = result;
    expect(score).toBe(1);
    const legacy = OfflineSweepSchema.parse({
      ...sweep,
      pairs: [{ ...pair, results: [{ ...withoutScore, error: 'Decider judge failed' }] }],
    });
    expect(legacy.pairs[0].results[0].score).toBeNull();
    expect(summarizeSweep(legacy.pairs)[0].cases).toBe(0);
  });
});
