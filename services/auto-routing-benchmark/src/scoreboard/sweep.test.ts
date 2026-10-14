import { describe, expect, it, vi } from 'vitest';
import { DECIDER_CASES, FRONTIER_CASES } from '../datasets/decider-cases';
import { OfflineSweepSchema, type OfflineSweep } from './schema';
import { containerTtftMs, readSweepCompletion, selectSweepCases, summarizeSweep } from './sweep';

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
  ttftMs: 25,
};
const pair = { model: 'fixture/model', variant: null };

describe('summarizeSweep', () => {
  it.each([
    'OpenRouter transport or body read failed',
    'OpenRouter returned HTTP 429',
    'OpenRouter response is missing valid usage.cost',
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
        p50TtftMs: 25,
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

  it.each([
    'OpenRouter response is missing answer content',
    'Container response is missing answer content',
  ])('counts an empty answer as a model failure without usage: %s', error => {
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
            error,
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
      pairs: [
        {
          ...pair,
          results: [{ ...withoutScore, error: 'OpenRouter response is missing valid usage.cost' }],
        },
      ],
    });
    expect(legacy.pairs[0].results[0].score).toBeNull();
    expect(summarizeSweep(legacy.pairs)[0].cases).toBe(0);
  });

  it('takes TTFT medians only from graded rows with measured first tokens', () => {
    const summaries = summarizeSweep([
      {
        ...pair,
        results: [
          result,
          { ...result, ttftMs: 75 },
          { ...result, ttftMs: null },
          { ...result, ttftMs: 10000, score: null, error: 'grader_failed' },
        ],
      },
    ]);
    expect(summaries[0]).toMatchObject({ cases: 3, errors: 1, p50TtftMs: 50 });
    expect(
      summarizeSweep([{ ...pair, results: [{ ...result, ttftMs: undefined }] }])[0].p50TtftMs
    ).toBeNull();
  });
});

describe('selectSweepCases', () => {
  it('defaults to efficient without frontier cases', () => {
    expect(selectSweepCases()).toBe(DECIDER_CASES);
    expect(selectSweepCases('efficient').every(benchCase => benchCase.tier !== 'frontier')).toBe(
      true
    );
    expect(selectSweepCases().some(benchCase => benchCase.taskType === 'agentic_execution')).toBe(
      true
    );
  });

  it('selects only the frontier suite, including its long-context cases', () => {
    expect(selectSweepCases('frontier')).toBe(FRONTIER_CASES);
    expect(FRONTIER_CASES.length).toBeGreaterThan(0);
    expect(FRONTIER_CASES.every(benchCase => benchCase.tier === 'frontier')).toBe(true);
    expect(FRONTIER_CASES.some(benchCase => benchCase.longContext)).toBe(true);
    const efficientIds = new Set(DECIDER_CASES.map(benchCase => benchCase.id));
    expect(FRONTIER_CASES.some(benchCase => efficientIds.has(benchCase.id))).toBe(false);
  });
});

describe('readSweepCompletion', () => {
  it.each(['content', 'reasoning', 'reasoning_content', 'reasoning_details'])(
    'measures first %s delta from a fragmented SSE fixture and retains final usage',
    async field => {
      const firstDelta =
        field === 'reasoning_details'
          ? { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-reasoning' }] }
          : { [field]: field === 'content' ? 'A' : 'Thinking' };
      const fixture = [
        ': OPENROUTER PROCESSING',
        '',
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
        '',
        `data: ${JSON.stringify({ choices: [{ delta: firstDelta }] })}`,
        '',
        'data: {"choices":[{"delta":{"content":"é"}}]}',
        '',
        'data: {"choices":[],"usage":{"cost":0.012}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\r\n');
      const bytes = new TextEncoder().encode(fixture);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 7));
          offset = Math.min(bytes.length, offset + 7);
        },
      });
      const now = vi.fn(() => 175);
      expect(await readSweepCompletion(new Response(stream), 100, now)).toEqual({
        output: field === 'content' ? 'Aé' : 'é',
        costUsd: 0.012,
        ttftMs: 75,
      });
      expect(now).toHaveBeenCalledTimes(1);
    }
  );

  it('leaves absent usage and first tokens unavailable', async () => {
    const response = new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    expect(await readSweepCompletion(response, 100)).toEqual({
      output: '',
      costUsd: null,
      ttftMs: null,
    });
  });

  it('accepts explicit null error fields in answer and usage chunks', async () => {
    const response = new Response([
      'data: {"error":null,"choices":[{"delta":{"content":"answer"}}]}',
      '',
      'data: {"error":null,"choices":[],"usage":{"cost":0.012}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'));
    expect(await readSweepCompletion(response, 100, () => 175)).toEqual({
      output: 'answer',
      costUsd: 0.012,
      ttftMs: 75,
    });
  });

  it.each(['', 'data: {"error":{"message":"after completion"}}\n\n'])(
    'cancels an open connection at [DONE] without consuming trailing data: %s',
    async trailingData => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
            'data: {"choices":[],"usage":{"cost":0.012}}\n\n' +
            'data: [DONE]\n\n' + trailingData
          ));
        },
        cancel,
      });
      expect(await readSweepCompletion(new Response(stream), 100, () => 175)).toEqual({
        output: 'answer',
        costUsd: 0.012,
        ttftMs: 75,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stream.locked).toBe(false);
    }
  );

  it('rejects incomplete and failed streams instead of grading partial answers', async () => {
    await expect(
      readSweepCompletion(
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        0
      )
    ).rejects.toThrow('before [DONE]');
    await expect(
      readSweepCompletion(
        new Response('data: {"error":{"message":"provider failure"}}\n\ndata: [DONE]\n\n'),
        0
      )
    ).rejects.toThrow('stream returned an error');
  });
});

describe('containerTtftMs', () => {
  it('uses the first text event timestamp relative to request start', () => {
    expect(
      containerTtftMs(
        [
          'not json',
          '{"type":"step_start","timestamp":1010}',
          '{"type":"text","timestamp":1040,"part":{"text":"answer","time":{"end":1090}}}',
          '{"type":"text","timestamp":1090,"part":{"text":"more"}}',
        ],
        1000
      )
    ).toBe(40);
  });

  it('accepts text start timestamps and leaves untimed events unavailable', () => {
    expect(
      containerTtftMs(
        ['{"type":"text","part":{"text":"answer","time":{"start":1060,"end":1100}}}'],
        1000
      )
    ).toBe(60);
    expect(containerTtftMs(['{"type":"text","part":{"text":"answer"}}'], 1000)).toBeNull();
    expect(containerTtftMs(['{"type":"text","timestamp":900,"text":"answer"}'], 1000)).toBeNull();
  });
});
