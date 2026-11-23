import { describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_CASE_STOP_REASONS,
  BenchmarkCaseCancelledError,
  BenchmarkCaseNotStartedError,
  DECIDER_CLI_TIMEOUT_MS,
  PAID_GENERATION_HEADER,
  cancelDeciderCase,
  checkPaidCaseAdmission,
  decodePaidGenerationHeader,
  destroyDeciderCliContainer,
  encodePaidGenerationHeader,
  fetchProbeThroughRunner,
  isCatalogLoadFailureResult,
  isExactModelUnavailableResult,
  isUnsupportedModelResult,
  parseContainerRunResponse,
  runDeciderCaseViaCli,
  trustedCaseStop,
  warmUpCliContainer,
} from './cli-runner';
import { DECIDER_CASES, FRONTIER_CASES, type DeciderCase } from './datasets/decider-cases';
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

describe('parseContainerRunResponse token usage', () => {
  it('exposes separate token categories to CLI consumers', () => {
    const result = parseContainerRunResponse(
      {
        exitCode: 0,
        durationMs: 12,
        stderrTail: '',
        stdoutLines: [
          JSON.stringify({
            type: 'step_finish',
            part: { tokens: { input: 11, cache: { read: 22 }, output: 33, reasoning: 44 } },
          }),
        ],
      },
      Date.now(),
      'candidate/model'
    );
    expect(result).toMatchObject({
      inputTokens: 11,
      cachedInputTokens: 22,
      outputTokens: 33,
      reasoningTokens: 44,
    });
  });
});

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

describe('runDeciderCaseViaCli isolated body', () => {
  async function sentBody(benchCase: DeciderCase) {
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
      variant: 'high',
    });
    const request = fetch.mock.calls[0]?.[0];
    if (!request) throw new Error('no container request');
    return readJsonBody(request);
  }

  it('isolates a tool-required case without a session', async () => {
    const body = await sentBody({ ...benchCase, requiredToolCalls: 1 });
    expect(body.isolated).toBe(true);
    expect(body).not.toHaveProperty('seed');
  });

  it('keeps the measured body of an ordinary case', async () => {
    const body = await sentBody(benchCase);
    expect(Object.keys(body)).toEqual([
      'model',
      'prompt',
      'kiloToken',
      'kiloApiUrl',
      'orgId',
      'timeoutMs',
      'variant',
      'resultCallback',
    ]);
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

  it('treats an empty catalog as a transient catalog failure', () => {
    const empty = {
      ...emptyResult,
      stderrTail: 'Model not found: kilo/candidate/model. No models are currently available.',
    };
    expect(isCatalogLoadFailureResult(empty)).toBe(true);
    expect(isExactModelUnavailableResult(empty, 'candidate/model')).toBe(false);
  });

  it.each([
    { text: 'answer' },
    { costUsd: 0.01 },
    { timedOut: true },
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

describe('gateway model resolution failures', () => {
  const emptyResult = { text: '', stderrTail: '', costUsd: null, timedOut: false };
  const diagnostic = '\u001b[91m\u001b[1mError: \u001b[0mUnsupported model mimo-v2.5\n';

  it.each([null, 0])('recognizes an unbilled rejection with cost %s', costUsd => {
    expect(
      isUnsupportedModelResult(
        { ...emptyResult, costUsd, stderrTail: diagnostic },
        'xiaomi/mimo-v2.5'
      )
    ).toBe(true);
  });

  it('accepts the kilo-prefixed identifier', () => {
    expect(
      isUnsupportedModelResult(
        { ...emptyResult, stderrTail: 'Error: Unsupported model kilo/xiaomi/mimo-v2.5' },
        'xiaomi/mimo-v2.5'
      )
    ).toBe(true);
  });

  it('tolerates trailing punctuation and a suffix after the model name', () => {
    expect(
      isUnsupportedModelResult(
        {
          ...emptyResult,
          stderrTail: 'Error: Unsupported model mimo-v2.5. Pick another model to continue.',
        },
        'xiaomi/mimo-v2.5'
      )
    ).toBe(true);
    expect(
      isUnsupportedModelResult(
        { ...emptyResult, stderrTail: 'Unsupported model mimo-v2.5,' },
        'xiaomi/mimo-v2.5'
      )
    ).toBe(true);
  });

  it.each([
    { text: 'answer', stderrTail: diagnostic },
    { costUsd: 0.01, stderrTail: diagnostic },
    { timedOut: true, stderrTail: diagnostic },
    { stderrTail: 'Error: Unsupported model other/model' },
    { stderrTail: 'Error: Unsupported model mimo-v2.5-extra' },
    { stderrTail: 'Error: Model not found: kilo/xiaomi/mimo-v2.5.' },
  ])('does not treat other outcomes as a resolution failure: %j', overrides => {
    expect(isUnsupportedModelResult({ ...emptyResult, ...overrides }, 'xiaomi/mimo-v2.5')).toBe(
      false
    );
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

  it('does not retain a lookup identity for an empty catalog', () => {
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
    expect(result.unavailableModelId).toBeUndefined();
    expect(isCatalogLoadFailureResult(result)).toBe(true);
    expect(isExactModelUnavailableResult(result, 'candidate/model')).toBe(false);
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

const paidExecution = {
  runId: 'run-1',
  model: 'vendor/model',
  variant: 'high',
  rep: 2,
  caseId: 'case-1',
  token: 'claim-token',
  attemptStartedAt: 1_700_000_000_000,
};

describe('cancelDeciderCase', () => {
  it('sends the paid generation to the instance cancel endpoint', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({ cancelled: true, state: 'killed' }, { status: 200 })
    );
    const { env } = createEnv(fetch);

    await expect(
      cancelDeciderCase(env, { instanceName: 'run:model:2', execution: paidExecution })
    ).resolves.toEqual({ cancelled: true, state: 'killed' });

    const request = fetch.mock.calls[0]?.[0];
    if (!request) throw new Error('no container request');
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://container/cancel');
    expect(await readJsonBody(request)).toEqual({ execution: paidExecution });
  });

  it('reports a stale generation as not running', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ cancelled: false, state: 'not_running' }, { status: 200 })
    );
    const { env } = createEnv(fetch);

    await expect(
      cancelDeciderCase(env, { instanceName: 'run:model:2', execution: paidExecution })
    ).resolves.toEqual({ cancelled: false, state: 'not_running' });
  });

  it('refuses to cancel without the ledger generation', async () => {
    const fetch = vi.fn(async () => Response.json({ cancelled: false, state: 'not_running' }));
    const { env } = createEnv(fetch);
    const { attemptStartedAt: _attemptStartedAt, ...withoutGeneration } = paidExecution;

    await expect(
      cancelDeciderCase(env, { instanceName: 'run:model:2', execution: withoutGeneration })
    ).rejects.toThrow('cancelDeciderCase requires execution.attemptStartedAt');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unexpected container answer', async () => {
    const fetch = vi.fn(async () => Response.json({ cancelled: true, state: 'paused' }));
    const { env } = createEnv(fetch);

    await expect(
      cancelDeciderCase(env, { instanceName: 'run:model:2', execution: paidExecution })
    ).rejects.toThrow('container /cancel returned an unexpected body');
  });
});

describe('runDeciderCaseViaCli cancellation', () => {
  const params = {
    instanceName: 'run:model:0',
    model: 'vendor/model',
    benchCase,
    kiloToken: 'kilo-user-token',
    kiloApiUrl: 'http://host.docker.internal:3000',
  };

  it('reports a cancelled case as terminal instead of a container failure', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: 'case cancelled', cancelled: true }, { status: 409 })
    );
    const { env } = createEnv(fetch);

    await expect(runDeciderCaseViaCli(env, params)).rejects.toBeInstanceOf(
      BenchmarkCaseCancelledError
    );
    await expect(runDeciderCaseViaCli(env, params)).rejects.toThrow('container /run cancelled');
  });

  it('keeps an unrelated conflict a plain container failure', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'claim changed' }, { status: 409 }));
    const { env } = createEnv(fetch);

    await expect(runDeciderCaseViaCli(env, params)).rejects.toThrow(
      'container /run failed: HTTP 409'
    );
  });

  it.each([
    ['the canonical generation is no longer executing', 409, 'not_live'],
    ['admission cannot be verified', 503, 'ledger_unavailable'],
  ] as const)('reports known not started when %s', async (_kind, status, reason) => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: 'case not live', started: false, cancelled: false, reason },
        { status }
      )
    );
    const { env } = createEnv(fetch);

    const failure = await runDeciderCaseViaCli(env, params).catch(error => error);
    expect(failure).toBeInstanceOf(BenchmarkCaseNotStartedError);
    if (!(failure instanceof BenchmarkCaseNotStartedError)) throw new Error('wrong error');
    expect(failure.reason).toBe(reason);
  });
});

const generation = {
  runId: 'run-1',
  model: 'vendor/model',
  variant: 'high',
  rep: 2,
  caseId: 'case-1',
  attemptStartedAt: 1_700_000_000_000,
};

describe('paid generation header', () => {
  it('round-trips the ledger generation without dropping claim or fence details', () => {
    const execution = { ...generation, token: 'claim-token', canonicalGeneration: 4 };
    const encoded = encodePaidGenerationHeader(execution);
    if (encoded === null) throw new Error('generation header was not encoded');
    expect(decodePaidGenerationHeader(encoded)).toEqual(execution);
  });

  const incompleteGeneration = btoa(
    JSON.stringify({
      runId: 'run-1',
      model: 'vendor/model',
      variant: 'high',
      rep: 2,
      caseId: 'case-1',
    })
  );
  it.each([null, 'not-base64!', incompleteGeneration])(
    'rejects a header that is not one complete generation: %s',
    value => {
      expect(decodePaidGenerationHeader(value)).toBeNull();
    }
  );

  it('is sent with a decider run that has a ledgered start', async () => {
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
      variant: 'high',
      resultCallback: {
        url: 'https://bench.test/container/case-result',
        execution: { ...generation, token: 'claim-token' },
      },
    });

    const request = fetch.mock.calls[0]?.[0];
    if (!request) throw new Error('no container request');
    expect(decodePaidGenerationHeader(request.headers.get(PAID_GENERATION_HEADER))).toEqual({
      ...generation,
      token: 'claim-token',
    });
  });
});

function admissionDb(first: () => Promise<unknown>) {
  const sql: string[] = [];
  const bindings: unknown[][] = [];
  const db = {
    prepare: (statement: string) => {
      sql.push(statement);
      return {
        bind: (...values: unknown[]) => {
          bindings.push(values);
          return { first };
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql, bindings };
}

const admittedGeneration = { ...generation, token: 'claim-token' };

describe('checkPaidCaseAdmission', () => {
  it('accepts the running canonical generation this start claimed', async () => {
    const { db, sql, bindings } = admissionDb(async () => ({ generation: 4 }));

    await expect(checkPaidCaseAdmission(db, admittedGeneration)).resolves.toEqual({
      live: true,
      generation: 4,
    });
    expect(sql[0]).toContain('benchmark_case_runs');
    expect(sql[0]).toContain('executor_run_id = ?');
    expect(sql[0]).toContain('executor_token = ?');
    expect(sql[0]).toContain("status = 'running'");
    expect(bindings[0]).toEqual([
      generation.runId,
      generation.model,
      generation.variant,
      generation.rep,
      generation.caseId,
      'claim-token',
      new Date(generation.attemptStartedAt).toISOString(),
      null,
      null,
      null,
      null,
    ]);
  });

  it('rejects a generation that paused, settled or was superseded', async () => {
    await expect(
      checkPaidCaseAdmission(admissionDb(async () => null).db, admittedGeneration)
    ).resolves.toEqual({ live: false, reason: 'not_live' });
  });

  it('fails closed when admission cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      checkPaidCaseAdmission(
        admissionDb(async () => {
          throw new Error('D1_ERROR: overloaded');
        }).db,
        admittedGeneration
      )
    ).resolves.toEqual({ live: false, reason: 'ledger_unavailable' });
  });
});

const caseInference = {
  url: 'https://worker.test/case-inference',
  authorization: 'Bearer capability-token',
  invocation: 'eyJzdGFydGVkQXQiOjF9',
  invocationHeader: 'x-kilo-benchmark-case',
};

const probeParams = {
  instanceName: 'run:model:0',
  execution: { ...generation, token: 'claim-token' },
  endpoint: 'responses' as const,
  inference: caseInference,
  body: '{"model":"vendor/model"}',
};

describe('trusted case stop', () => {
  it('lists exactly the reasons the Worker router emits', () => {
    expect([...BENCHMARK_CASE_STOP_REASONS]).toEqual([
      'paused',
      'no_payer',
      'cancelled',
      'not_live',
      'infra_unavailable',
      'model_permanently_failed',
    ]);
  });

  it.each([
    ['paused', 409],
    ['no_payer', 402],
    ['cancelled', 499],
    ['not_live', 409],
    ['infra_unavailable', 503],
    ['model_permanently_failed', 409],
  ] as const)('trusts a Worker refusal carrying %s', (reason, status) => {
    const response = new Response('{}', {
      status,
      headers: { 'x-kilo-benchmark-stop': reason },
    });
    expect(trustedCaseStop(response)).toEqual({ reason, status });
  });

  it('ignores the marker on an admitted reply, whatever the body says', () => {
    for (const admission of ['admitted', 'refused_by_provider']) {
      const response = new Response('provider text: paused / no_payer', {
        status: 200,
        headers: { 'x-kilo-benchmark-admission': admission, 'x-kilo-benchmark-stop': 'paused' },
      });
      expect(trustedCaseStop(response)).toBeNull();
    }
  });

  it('ignores an unknown reason or a bare header', () => {
    for (const value of ['bill_me_later', '']) {
      const response = new Response('{}', {
        status: 409,
        headers: { 'x-kilo-benchmark-stop': value },
      });
      expect(trustedCaseStop(response)).toBeNull();
    }
    expect(trustedCaseStop(new Response('{}', { status: 409 }))).toBeNull();
  });

  it('carries the stop into a cancelled run error', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json(
        { error: 'case cancelled', cancelled: true },
        { status: 409, headers: { 'x-kilo-benchmark-stop': 'paused' } }
      )
    );
    const { env } = createEnv(fetch);

    const failure = await runDeciderCaseViaCli(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
    }).catch(error => error);

    expect(failure).toBeInstanceOf(BenchmarkCaseCancelledError);
    if (!(failure instanceof BenchmarkCaseCancelledError)) throw new Error('wrong error');
    expect(failure.stop).toEqual({ reason: 'paused', status: 409 });
  });
});

describe('fetchProbeThroughRunner', () => {
  it('sends only the endpoint, envelope and body to the runner object', async () => {
    const fetch = vi.fn(
      async (_request: Request) =>
        new Response('event: done\n', { headers: { 'content-type': 'text/event-stream' } })
    );
    const { env } = createEnv(fetch);

    const response = await fetchProbeThroughRunner(env, probeParams);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const request = fetch.mock.calls[0]?.[0];
    if (!request) throw new Error('no container request');
    expect(request.url).toBe('http://container/probe');
    expect(await readJsonBody(request)).toEqual({
      execution: probeParams.execution,
      endpoint: 'responses',
      inference: caseInference,
      body: probeParams.body,
      timeoutMs: DECIDER_CLI_TIMEOUT_MS,
    });
  });

  it('reports a cancelled probe as terminal', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json(
        { error: 'case cancelled', cancelled: true },
        { status: 409, headers: { 'x-benchmark-runner': 'cancelled' } }
      )
    );
    const { env } = createEnv(fetch);

    await expect(fetchProbeThroughRunner(env, probeParams)).rejects.toBeInstanceOf(
      BenchmarkCaseCancelledError
    );
  });

  it('reports other runner failures as transport errors', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json(
        { error: 'timeout' },
        { status: 504, headers: { 'x-benchmark-runner': 'timeout' } }
      )
    );
    const { env } = createEnv(fetch);

    await expect(fetchProbeThroughRunner(env, probeParams)).rejects.toThrow(
      'container /probe timeout'
    );
  });

  it.each(['not_live', 'ledger_unavailable'] as const)(
    'reports known not started when admission refuses a probe with %s',
    async reason => {
      const fetch = vi.fn(async (_request: Request) =>
        Response.json(
          { error: reason, cancelled: false },
          {
            status: reason === 'ledger_unavailable' ? 503 : 409,
            headers: { 'x-benchmark-runner': reason },
          }
        )
      );
      const { env } = createEnv(fetch);

      const failure = await fetchProbeThroughRunner(env, probeParams).catch(error => error);
      expect(failure).toBeInstanceOf(BenchmarkCaseNotStartedError);
      if (!(failure instanceof BenchmarkCaseNotStartedError)) throw new Error('wrong error');
      expect(failure.reason).toBe(reason);
    }
  );

  it.each([
    ['an endpoint outside the case route', { endpoint: 'https://evil.test/x' as 'responses' }],
    ['a non-bearer authorization', { inference: { ...caseInference, authorization: 'bot-token' } }],
    ['a non-base64url invocation', { inference: { ...caseInference, invocation: 'a b' } }],
  ])('refuses %s before reaching the runner', async (_kind, overrides) => {
    const fetch = vi.fn();
    const { env } = createEnv(fetch);

    await expect(fetchProbeThroughRunner(env, { ...probeParams, ...overrides })).rejects.toThrow(
      'probe request rejected'
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
