import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  ENKRYPT_DETECT_URL,
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  ENKRYPT_MAX_SCAN_CHARACTERS,
  MAX_ENKRYPT_CREDITS_PER_CALL,
  scanRequest,
  type EnkryptDetectDependencies,
  type EnkryptGuardrailScan,
} from './detect';

const mockedWarnExceptInTest = jest.fn();

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  warnExceptInTest: (...args: unknown[]) => mockedWarnExceptInTest(...args),
}));

const config = {
  scanToolResults: true,
  status: 'ready',
  detectors: {
    injection_attack: { enabled: true, need_explanation: false },
    pii: { enabled: true, entities: ['secrets'] },
    toxicity: { enabled: true },
    keyword_detector: { enabled: true, banned_keywords: ['Project Phoenix'] },
  },
  blockingDetectors: ['injection_attack', 'toxicity', 'keyword_detector'],
} satisfies EnkryptGuardrailScan['config'];

function makeScan(overrides: Partial<EnkryptGuardrailScan> = {}): EnkryptGuardrailScan {
  return {
    sessionId: 'ses_e2e',
    organizationId: '00000000-0000-4000-8000-000000000002',
    kiloUserId: 'oauth/google:123',
    apiKind: 'chat_completions',
    clientRequestId: 'client-request-1',
    text: 'tool output',
    config,
    ...overrides,
  };
}

function detectResponse(
  body: {
    summary: Record<string, unknown>;
    details?: Record<string, unknown>;
    result_message?: string | null;
  },
  init: { status?: number; credits?: string } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.credits === undefined ? {} : { 'x-enkrypt-credits-cost': init.credits }),
    },
  });
}

function deps(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<EnkryptDetectDependencies> = {}
): EnkryptDetectDependencies {
  return {
    apiKey: 'test-enkrypt-key',
    fetch: jest.fn(fetchImpl) as unknown as typeof fetch,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function fetchCalls(dependencies: EnkryptDetectDependencies) {
  return jest.mocked(dependencies.fetch).mock.calls as unknown as [string, RequestInit][];
}

describe('scanRequest', () => {
  beforeEach(() => {
    mockedWarnExceptInTest.mockClear();
  });

  it('sends the request text, inline detectors, and only opaque ids to Enkrypt', async () => {
    const dependencies = deps(async () =>
      detectResponse({ summary: { injection_attack: 0, pii: 0 }, result_message: null })
    );

    await scanRequest(makeScan(), dependencies);

    const [[url, init]] = fetchCalls(dependencies);
    expect(url).toBe(ENKRYPT_DETECT_URL);
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      apikey: 'test-enkrypt-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'tool output',
      detectors: config.detectors,
      user_metadata: { organization_id: '00000000-0000-4000-8000-000000000002' },
    });
  });

  it.each([
    ['an implausibly large', '1e40', MAX_ENKRYPT_CREDITS_PER_CALL],
    ['a negative', '-3', null],
    ['a non-numeric', 'abc', null],
  ])('records %s credits cost safely', async (_name, header, creditsCost) => {
    const result = await scanRequest(
      makeScan(),
      deps(async () => detectResponse({ summary: {} }, { credits: header }))
    );

    expect(result.charges).toEqual([expect.objectContaining({ creditsCost })]);
  });

  it('allows a clean request and charges the reported credits', async () => {
    const result = await scanRequest(
      makeScan(),
      deps(async () =>
        detectResponse(
          { summary: { injection_attack: 0, pii: 0 }, result_message: null },
          { credits: '3' }
        )
      )
    );

    expect(result).toEqual({
      verdict: { action: 'allow' },
      charges: [
        {
          organizationId: '00000000-0000-4000-8000-000000000002',
          kiloUserId: 'oauth/google:123',
          sessionId: 'ses_e2e',
          apiKind: 'chat_completions',
          decision: 'allowed',
          creditsCost: 3,
        },
      ],
    });
  });

  it('blocks when a block-type detector fires and shows the Enkrypt block message', async () => {
    const result = await scanRequest(
      makeScan(),
      deps(async () =>
        detectResponse(
          {
            summary: { injection_attack: 1, pii: 0 },
            result_message: 'Potential prompt injection detected.\u0007',
          },
          { credits: '2' }
        )
      )
    );

    expect(result.verdict).toEqual({
      action: 'block',
      message:
        "Your organization's Enkrypt AI guardrail blocked this request (detected: injection_attack). Potential prompt injection detected.",
    });
    expect(result.charges).toEqual([
      expect.objectContaining({ decision: 'blocked', creditsCost: 2 }),
    ]);
  });

  it('uses a default reason when Enkrypt returns no block message', async () => {
    const result = await scanRequest(
      makeScan(),
      deps(async () => detectResponse({ summary: { toxicity: ['insult'] }, result_message: null }))
    );

    expect(result.verdict).toEqual({
      action: 'block',
      message:
        "Your organization's Enkrypt AI guardrail blocked this request (detected: toxicity). The request was flagged by your organization policy. Review it and retry.",
    });
  });

  it('blocks a revise-type detector set to block without showing the redacted text', async () => {
    const result = await scanRequest(
      makeScan(),
      deps(async () =>
        detectResponse({
          summary: { keyword_detected: 1, pii: 0 },
          result_message: 'You are working on [KEYWORD_1]',
        })
      )
    );

    expect(result.verdict).toEqual({
      action: 'block',
      message:
        "Your organization's Enkrypt AI guardrail blocked this request (detected: keyword_detector). The request was flagged by your organization policy. Review it and retry.",
    });
    expect(result.charges).toEqual([expect.objectContaining({ decision: 'blocked' })]);
  });

  it.each([
    ['zero', 0],
    ['an empty list', []],
    ['false', false],
  ])('allows a request when a detector reports %s', async (_name, value) => {
    const result = await scanRequest(
      makeScan(),
      deps(async () => detectResponse({ summary: { injection_attack: value, toxicity: value } }))
    );

    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.charges).toEqual([expect.objectContaining({ decision: 'allowed' })]);
  });

  describe('when Enkrypt reports a detector error with HTTP 200', () => {
    const explanation =
      "Error: Client error '400 Bad Request' for url 'https://enkrypt-internal.example/policy' prompt-derived text";
    const policyConfig = {
      ...config,
      detectors: {
        ...config.detectors,
        topic_detector: { enabled: true, topic: ['finance'] },
        policy_violation: {
          enabled: true,
          need_explanation: false,
          policy_text: 'Never share credentials.',
        },
      },
      blockingDetectors: [...config.blockingDetectors, 'topic_detector', 'policy_violation'],
    } satisfies EnkryptGuardrailScan['config'];

    it.each([
      ['alone', { policy_violation: -1 }, 'detector_error:policy_violation'],
      [
        'next to detectors that did not fire',
        { injection_attack: 0, pii: 0, policy_violation: -1 },
        'detector_error:policy_violation',
      ],
      [
        'for several detectors',
        { injection_attack: 0, on_topic: -1, policy_violation: -1 },
        'detector_error:topic_detector,policy_violation',
      ],
    ])(
      'fails closed without retrying when it is reported %s',
      async (_name, summary, expectedError) => {
        const dependencies = deps(async () =>
          detectResponse(
            {
              summary,
              details: {
                policy_violation: {
                  violating_policy: 'Error',
                  explanation,
                  most_unsafe_content: '',
                },
              },
              result_message: null,
            },
            { credits: '4' }
          )
        );

        const result = await scanRequest(makeScan({ config: policyConfig }), dependencies);

        expect(dependencies.fetch).toHaveBeenCalledTimes(1);
        expect(result.verdict).toEqual({ action: 'unavailable' });
        expect(result.charges).toEqual([
          expect.objectContaining({ decision: 'error', creditsCost: 4 }),
        ]);
        expect(mockedWarnExceptInTest).toHaveBeenCalledWith(
          '[enkrypt-guardrail] decision',
          expect.objectContaining({
            decision: 'error_fail_closed',
            error: expectedError,
            attempts: 1,
            credits_cost: 4,
          })
        );
        const logged = JSON.stringify(mockedWarnExceptInTest.mock.calls);
        expect(logged).not.toContain('enkrypt-internal.example');
        expect(logged).not.toContain('prompt-derived text');
      }
    );
  });

  it('ignores detections from detectors it does not know', async () => {
    const result = await scanRequest(
      makeScan(),
      deps(async () => detectResponse({ summary: { system_prompt_similarity: 1 } }))
    );

    expect(result.verdict).toEqual({ action: 'allow' });
  });

  it('rejects every request without calling Enkrypt when the saved detectors are unreadable', async () => {
    const dependencies = deps(async () => detectResponse({ summary: {} }));

    const result = await scanRequest(
      makeScan({ config: { scanToolResults: true, status: 'invalid' } }),
      dependencies
    );

    expect(result).toEqual({ verdict: { action: 'unavailable' }, charges: [] });
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  it('allows a request when only a revise-type detector set to log fires', async () => {
    const result = await scanRequest(
      makeScan(),
      deps(async () =>
        detectResponse({
          summary: { injection_attack: 0, pii: 1 },
          result_message: 'redacted <SECRET_0> text',
        })
      )
    );

    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.charges).toEqual([expect.objectContaining({ decision: 'allowed' })]);
  });

  it('makes no call for an empty request', async () => {
    const dependencies = deps(async () => detectResponse({ summary: {} }));

    const result = await scanRequest(makeScan({ text: '' }), dependencies);

    expect(result).toEqual({ verdict: { action: 'allow' }, charges: [] });
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  describe('a request above the scan limit', () => {
    const text = 'a'.repeat(ENKRYPT_MAX_SCAN_CHARACTERS + 1);

    it('is rejected with the reason, never truncated or sent', async () => {
      const dependencies = deps(async () => detectResponse({ summary: {} }));

      const result = await scanRequest(makeScan({ text }), dependencies);

      expect(result).toEqual({
        verdict: {
          action: 'block',
          message: expect.stringContaining('cannot scan more than 500,000 characters'),
        },
        charges: [],
      });
      expect(result.verdict).toMatchObject({
        message: expect.stringContaining('Reduce the size of the conversation or tool output'),
      });
      expect(dependencies.fetch).not.toHaveBeenCalled();
    });
  });

  it('retries one transient failure and charges both calls', async () => {
    const responses = [
      detectResponse({ summary: {} }, { status: 502 }),
      detectResponse({ summary: { injection_attack: 0 } }, { credits: '2' }),
    ];
    const dependencies = deps(async () => responses.shift() ?? Response.error());

    const result = await scanRequest(makeScan(), dependencies);

    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.charges).toEqual([
      expect.objectContaining({ decision: 'error', creditsCost: null }),
      expect.objectContaining({ decision: 'allowed', creditsCost: 2 }),
    ]);
  });

  it('shares a single 30-second deadline across retry attempts', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const responses = [
      detectResponse({ summary: {} }, { status: 502 }),
      detectResponse({ summary: {} }),
    ];
    const dependencies = deps(async () => responses.shift() ?? Response.error(), {
      timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
    });

    try {
      await scanRequest(makeScan(), dependencies);

      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(30_000);
      const calls = fetchCalls(dependencies);
      expect(calls).toHaveLength(2);
      expect(calls[0][1].signal).toBe(calls[1][1].signal);
    } finally {
      timeout.mockRestore();
    }
  });

  it('does not retry a rate-limited call', async () => {
    const dependencies = deps(async () => detectResponse({ summary: {} }, { status: 429 }));

    const result = await scanRequest(makeScan(), dependencies);

    expect(dependencies.fetch).toHaveBeenCalledTimes(1);
    expect(result.verdict).toEqual({ action: 'unavailable' });
  });

  describe('when Enkrypt is unavailable', () => {
    const failures: [string, () => Promise<Response>][] = [
      ['a persistent server error', async () => detectResponse({ summary: {} }, { status: 503 })],
      ['a network error', async () => Promise.reject(new TypeError('fetch failed'))],
      ['a client error', async () => detectResponse({ summary: {} }, { status: 402 })],
      [
        'an invalid response',
        async () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
      ],
    ];

    it.each(failures)('rejects the request on %s', async (_name, failure) => {
      const result = await scanRequest(makeScan(), deps(failure));

      expect(result.verdict).toEqual({ action: 'unavailable' });
      expect(result.charges.every(charge => charge.decision === 'error')).toBe(true);
    });

    it('rejects the request when Enkrypt does not answer within the timeout', async () => {
      const hang = (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      const dependencies = deps(hang, { timeoutMs: 20 });

      const result = await scanRequest(makeScan(), dependencies);

      expect(result.verdict).toEqual({ action: 'unavailable' });
      expect(dependencies.fetch).toHaveBeenCalledTimes(1);
      expect(result.charges).toEqual([expect.objectContaining({ decision: 'error' })]);
    });

    it('rejects the request without calling Enkrypt when the API key is unset', async () => {
      const dependencies = deps(async () => detectResponse({ summary: {} }), {
        apiKey: undefined,
      });

      const result = await scanRequest(makeScan(), dependencies);

      expect(result).toEqual({ verdict: { action: 'unavailable' }, charges: [] });
      expect(dependencies.fetch).not.toHaveBeenCalled();
    });
  });
});
