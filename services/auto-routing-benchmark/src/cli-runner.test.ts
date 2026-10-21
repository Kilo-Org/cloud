import { describe, expect, it, vi } from 'vitest';
import {
  destroyDeciderCliContainer,
  isCatalogLoadFailureResult,
  isExactModelUnavailableResult,
  parseContainerRunResponse,
  runDeciderCaseViaCli,
  warmUpCliContainer,
} from './cli-runner';
import { DECIDER_CASES, FRONTIER_CASES } from './datasets/decider-cases';
import { materializeLongContext } from './datasets/long-context';

const benchCase = {
  id: 'case-1',
  taskType: 'implementation',
  subtaskType: 'feature_development',
  systemPrompt: 'system',
  userPrompt: 'user',
  check: { kind: 'exact', value: 'ok' },
} as const;

function createEnv(fetch: ReturnType<typeof vi.fn>) {
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const get = vi.fn(() => ({ fetch }));
  return { env: { BENCH_RUNNER: { idFromName, get } } as unknown as Env, fetch };
}

async function readJsonBody(request: Request) {
  return JSON.parse(await request.clone().text()) as Record<string, unknown>;
}

const FINAL_ANSWER =
  '\n\nIMPORTANT: Your final message must contain ONLY the answer in the exact requested format - no explanations, no preamble, no extra words.';

describe('runDeciderCaseViaCli prompt', () => {
  async function sentPrompt(benchCase: (typeof DECIDER_CASES)[number]) {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({ exitCode: 0, durationMs: 1, stdoutLines: [], stderrTail: '' })
    );
    const { env } = createEnv(fetch);
    await runDeciderCaseViaCli(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
    });
    const request = fetch.mock.calls[0]?.[0];
    if (!request) throw new Error('no container request');
    const body = await readJsonBody(request);
    if (typeof body.prompt !== 'string') throw new Error('prompt missing');
    return body.prompt;
  }

  it('sends an ordinary case without a snapshot', async () => {
    const ordinary = DECIDER_CASES.find(c => !c.longContext);
    if (!ordinary) throw new Error('dataset needs an ordinary case');
    expect(await sentPrompt(ordinary)).toBe(
      `${ordinary.systemPrompt}\n\n${ordinary.userPrompt}${FINAL_ANSWER}`
    );
  });

  it.each([
    ['efficient', DECIDER_CASES],
    ['frontier', FRONTIER_CASES],
  ])('sends a %s long-context case with its workspace snapshot', async (_router, cases) => {
    const longCase = cases.find(c => c.longContext);
    if (!longCase) throw new Error('dataset needs a long-context case');
    const materialized = materializeLongContext(longCase);
    const prompt = await sentPrompt(longCase);
    expect(prompt).toBe(
      `${materialized.systemPrompt}\n\n${materialized.userPrompt}${FINAL_ANSWER}`
    );
    expect(prompt).toContain('BEGIN WORKSPACE SNAPSHOT');
    expect(prompt.length).toBeGreaterThan(longCase.userPrompt.length * 10);
  });
});
describe('runDeciderCaseViaCli', () => {
  it('passes orgId through to the container run request when provided', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({
        exitCode: 0,
        durationMs: 10,
        stdoutLines: [],
        stderrTail: '',
      })
    );
    const { env } = createEnv(fetch);

    await runDeciderCaseViaCli(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      orgId: 'org-123',
    });

    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect(readJsonBody(request)).resolves.toMatchObject({
      model: 'vendor/model',
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      orgId: 'org-123',
    });
  });

  it('passes canonical variant as the container body variant field', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({
        exitCode: 0,
        durationMs: 10,
        stdoutLines: [],
        stderrTail: '',
      })
    );
    const { env } = createEnv(fetch);

    await runDeciderCaseViaCli(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      variant: 'xhigh',
    });

    const request = fetch.mock.calls[0]?.[0];
    await expect(readJsonBody(request)).resolves.toMatchObject({ variant: 'xhigh' });
  });

  it('accepts legacy reasoningEffort alias for the same body field', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({
        exitCode: 0,
        durationMs: 10,
        stdoutLines: [],
        stderrTail: '',
      })
    );
    const { env } = createEnv(fetch);

    await runDeciderCaseViaCli(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      reasoningEffort: 'high',
    });

    const request = fetch.mock.calls[0]?.[0];
    await expect(readJsonBody(request)).resolves.toMatchObject({ variant: 'high' });
  });

  it('surfaces structured CLI rate-limit events without changing the measured result', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        exitCode: 0,
        durationMs: 37,
        stdoutLines: [JSON.stringify({ type: 'error', error: { data: { statusCode: 429 } } })],
        stderrTail: '',
      })
    );
    const { env } = createEnv(fetch);
    const result = await runDeciderCaseViaCli(env, {
      instanceName: 'benchmark-slot:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'fake-token',
      kiloApiUrl: 'http://isolated.invalid',
    });
    expect(result).toMatchObject({
      exitCode: 0,
      text: '',
      costUsd: null,
      latencyMs: 37,
      stderrTail: '\nHTTP 429 provider throttle',
    });
  });
});

describe('CLI catalog load failures', () => {
  const diagnostic =
    'Model not found: kilo/candidate/model. Failed to load the Kilo model catalog (network). Check your connection and credentials.';
  const emptyResult = { text: '', stderrTail: diagnostic, costUsd: null, timedOut: false };

  it.each([null, 0])('recognizes an unbilled catalog failure with cost %s', costUsd => {
    expect(isCatalogLoadFailureResult({ ...emptyResult, costUsd })).toBe(true);
    expect(
      isCatalogLoadFailureResult({
        ...emptyResult,
        costUsd,
        stderrTail: `\u001b[31m${diagnostic}\u001b[0m`,
      })
    ).toBe(true);
  });

  it.each([
    { text: 'answer' },
    { costUsd: 0.01 },
    { timedOut: true },
    { stderrTail: 'Model not found: kilo/candidate/model. No models are currently available.' },
    { stderrTail: 'Provider API failed (network). Check your connection and credentials.' },
    { stderrTail: '' },
  ])('preserves measurements and unrelated failures: %j', overrides => {
    expect(isCatalogLoadFailureResult({ ...emptyResult, ...overrides })).toBe(false);
  });

  it.each([undefined, 'candidate/model', 'kilo/candidate/model'])(
    'rejects catalog failure as exact unavailability with stored identity %s',
    unavailableModelId => {
      expect(
        isExactModelUnavailableResult({ ...emptyResult, unavailableModelId }, 'candidate/model')
      ).toBe(false);
    }
  );

  it.each([
    { stdoutLines: [] },
    {
      stdoutLines: [
        JSON.stringify({
          type: 'error',
          error: {
            name: 'ProviderModelNotFoundError',
            data: { providerID: 'kilo', modelID: 'candidate/model' },
          },
        }),
      ],
    },
  ])('does not retain an unavailable identity from a catalog failure: %j', ({ stdoutLines }) => {
    const result = parseContainerRunResponse(
      { exitCode: 0, durationMs: 12, stdoutLines, stderrTail: diagnostic },
      Date.now(),
      'candidate/model'
    );
    expect(isCatalogLoadFailureResult(result)).toBe(true);
    expect(isExactModelUnavailableResult(result, 'candidate/model')).toBe(false);
    expect(result.unavailableModelId).toBeUndefined();
  });
});

describe('exact CLI model unavailability', () => {
  const emptyResult = { text: '', stderrTail: '', costUsd: null, timedOut: false };

  it.each([
    { providerID: 'kilo', modelID: 'candidate/model', expected: true },
    { providerID: 'candidate', modelID: 'model', expected: true },
    { providerID: 'kilo', modelID: 'another/model', expected: false },
    { providerID: 'another', modelID: 'candidate/model', expected: false },
  ])(
    'matches structured lookup errors to the exact requested model: %j',
    ({ expected, ...data }) => {
      const result = parseContainerRunResponse(
        {
          exitCode: 0,
          durationMs: 12,
          stdoutLines: [
            JSON.stringify({ type: 'error', error: { name: 'ProviderModelNotFoundError', data } }),
          ],
          stderrTail: '',
        },
        Date.now(),
        'candidate/model'
      );
      expect(isExactModelUnavailableResult(result, 'candidate/model')).toBe(expected);
      expect(isExactModelUnavailableResult(result, 'different/model')).toBe(false);
    }
  );

  it('matches ANSI-colored diagnostics without confusing a different model or assistant output', () => {
    for (const diagnostic of [
      'Error: Model not found: kilo/candidate/model\nTry: `kilo models` to list available models',
      '\u001b[31mError:\u001b[0m Model not found: candidate/model',
      'Error: Model not found: kilo/candidate/model. No models are currently available.',
      'Error: Model not found: kilo/candidate/model. Did you mean: candidate/other?',
    ]) {
      expect(
        isExactModelUnavailableResult({ ...emptyResult, stderrTail: diagnostic }, 'candidate/model')
      ).toBe(true);
    }
    expect(
      isExactModelUnavailableResult(
        { ...emptyResult, stderrTail: 'Model not found: kilo/another/model' },
        'candidate/model'
      )
    ).toBe(false);
    expect(
      isExactModelUnavailableResult(
        { ...emptyResult, text: 'Model not found: candidate/model' },
        'candidate/model'
      )
    ).toBe(false);
    expect(
      isExactModelUnavailableResult(
        { ...emptyResult, text: 'answer', stderrTail: 'Model not found: candidate/model' },
        'candidate/model'
      )
    ).toBe(false);
  });

  it('persists stderr lookup failures even when the CLI returns a successful process exit', () => {
    const result = parseContainerRunResponse(
      {
        exitCode: 0,
        durationMs: 10,
        stdoutLines: [],
        stderrTail:
          'Error: Model not found: kilo/candidate/model. No models are currently available.',
      },
      Date.now(),
      'candidate/model'
    );
    expect(result.unavailableModelId).toBe('candidate/model');
    expect(isExactModelUnavailableResult(result, 'different/model')).toBe(false);
  });

  it.each([
    { costUsd: 0.01, timedOut: false },
    { costUsd: null, timedOut: true },
  ])('preserves billed or timed-out failures as measurements: %j', measured => {
    const failure = {
      ...emptyResult,
      ...measured,
      stderrTail: 'Model not found: kilo/candidate/model',
    };
    expect(isExactModelUnavailableResult(failure, 'candidate/model')).toBe(false);
    expect(
      isExactModelUnavailableResult(
        { ...failure, unavailableModelId: 'kilo/candidate/model' },
        'candidate/model'
      )
    ).toBe(false);
    const result = parseContainerRunResponse(
      {
        exitCode: 1,
        durationMs: 12,
        stdoutLines: [
          JSON.stringify({
            type: 'error',
            error: {
              name: 'ProviderModelNotFoundError',
              data: { providerID: 'kilo', modelID: 'candidate/model' },
            },
          }),
          JSON.stringify({ type: 'step_finish', part: { cost: measured.costUsd ?? 0 } }),
        ],
        stderrTail: failure.stderrTail,
        timedOut: measured.timedOut,
      },
      Date.now(),
      'candidate/model'
    );
    expect(result.unavailableModelId).toBeUndefined();
    expect(isExactModelUnavailableResult(result, 'candidate/model')).toBe(false);
  });

  it('does not treat missing lookup identity or ordinary provider API failures as unavailability', () => {
    for (const error of [
      { name: 'ProviderModelNotFoundError', data: { modelID: 'candidate/model' } },
      { name: 'APIError', data: { statusCode: 404 } },
    ]) {
      const failure = parseContainerRunResponse(
        {
          exitCode: 1,
          durationMs: 12,
          stdoutLines: [JSON.stringify({ type: 'error', error })],
          stderrTail: 'Provider API failed: resource not found',
        },
        Date.now(),
        'candidate/model'
      );
      expect(isExactModelUnavailableResult(failure, 'candidate/model')).toBe(false);
    }
  });
});

describe('warmUpCliContainer', () => {
  it('passes orgId through to the container warmup request when provided', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({ exitCode: 0, durationMs: 10 })
    );
    const { env } = createEnv(fetch);

    await warmUpCliContainer(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      orgId: 'org-123',
    });

    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect(readJsonBody(request)).resolves.toMatchObject({
      model: 'vendor/model',
      kiloToken: 'kilo-user-token',
      orgId: 'org-123',
    });
  });
});

describe('destroyDeciderCliContainer', () => {
  it('calls the container admin destroy endpoint for the instance name', async () => {
    const fetch = vi.fn(async () => new Response('destroyed', { status: 200 }));
    const idFromName = vi.fn((name: string) => `id:${name}`);
    const get = vi.fn(() => ({ fetch }));
    const env = { BENCH_RUNNER: { idFromName, get } } as unknown as Env;

    await destroyDeciderCliContainer(env, { instanceName: 'run:model:2' });

    expect(idFromName).toHaveBeenCalledWith('run:model:2');
    expect(get).toHaveBeenCalledWith('id:run:model:2');
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'http://container/admin/destroy',
      })
    );
  });

  it('throws when the container destroy endpoint fails', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }));
    const env = {
      BENCH_RUNNER: {
        idFromName: (name: string) => `id:${name}`,
        get: () => ({ fetch }),
      },
    } as unknown as Env;

    await expect(destroyDeciderCliContainer(env, { instanceName: 'run:model:2' })).rejects.toThrow(
      'container /admin/destroy failed: HTTP 500 nope'
    );
  });
});
