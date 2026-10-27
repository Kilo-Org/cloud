import { describe, expect, it, jest } from '@jest/globals';
import {
  ENKRYPT_DETECT_URL,
  ENKRYPT_MAX_SCAN_CHARACTERS,
  scanTurnDelta,
  type EnkryptDetectDependencies,
  type EnkryptGuardrailScan,
} from './detect';

const config = {
  failMode: 'open',
  detectors: {
    injection_attack: { enabled: true, need_explanation: false },
    pii: { enabled: true, entities: ['secrets'] },
  },
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
  body: { summary: Record<string, unknown>; result_message?: string | null },
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

describe('scanTurnDelta', () => {
  it('sends the turn text, inline detectors, and only opaque ids to Enkrypt', async () => {
    const dependencies = deps(async () =>
      detectResponse({ summary: { injection_attack: 0, pii: 0 }, result_message: null })
    );

    await scanTurnDelta(makeScan(), dependencies);

    const [[url, init]] = fetchCalls(dependencies);
    expect(url).toBe(ENKRYPT_DETECT_URL);
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      apikey: 'test-enkrypt-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'tool output',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        pii: { enabled: true, entities: ['secrets'] },
      },
      user_metadata: { organization_id: '00000000-0000-4000-8000-000000000002' },
    });
  });

  it('allows a clean turn and charges the reported credits', async () => {
    const result = await scanTurnDelta(
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
    const result = await scanTurnDelta(
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
    const result = await scanTurnDelta(
      makeScan(),
      deps(async () => detectResponse({ summary: { toxicity: ['insult'] }, result_message: null }))
    );

    expect(result.verdict).toEqual({
      action: 'block',
      message:
        "Your organization's Enkrypt AI guardrail blocked this request (detected: toxicity). The request was flagged as unsafe. Review it and retry.",
    });
  });

  it('allows a turn when only the revise-type pii detector fires', async () => {
    const result = await scanTurnDelta(
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

  it('makes no call for an empty turn', async () => {
    const dependencies = deps(async () => detectResponse({ summary: {} }));

    const result = await scanTurnDelta(makeScan({ text: '' }), dependencies);

    expect(result).toEqual({ verdict: { action: 'allow' }, charges: [] });
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  describe('a turn above the scan limit', () => {
    const text = 'a'.repeat(ENKRYPT_MAX_SCAN_CHARACTERS + 1);

    it('is sent unscanned when failing open, never truncated', async () => {
      const dependencies = deps(async () => detectResponse({ summary: {} }));

      const result = await scanTurnDelta(makeScan({ text }), dependencies);

      expect(result).toEqual({ verdict: { action: 'allow' }, charges: [] });
      expect(dependencies.fetch).not.toHaveBeenCalled();
    });

    it('is rejected without a retry hint when failing closed', async () => {
      const dependencies = deps(async () => detectResponse({ summary: {} }));

      const result = await scanTurnDelta(
        makeScan({ text, config: { ...config, failMode: 'closed' } }),
        dependencies
      );

      expect(result).toEqual({
        verdict: {
          action: 'block',
          message: expect.stringContaining('cannot scan more than 500,000 characters'),
        },
        charges: [],
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

    const result = await scanTurnDelta(makeScan(), dependencies);

    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.charges).toEqual([
      expect.objectContaining({ decision: 'error', creditsCost: null }),
      expect.objectContaining({ decision: 'allowed', creditsCost: 2 }),
    ]);
  });

  it('does not retry a rate-limited call', async () => {
    const dependencies = deps(async () => detectResponse({ summary: {} }, { status: 429 }));

    const result = await scanTurnDelta(makeScan(), dependencies);

    expect(dependencies.fetch).toHaveBeenCalledTimes(1);
    expect(result.verdict).toEqual({ action: 'allow' });
  });

  describe('fail mode', () => {
    const failures: [string, () => Promise<Response>][] = [
      ['a persistent server error', async () => detectResponse({ summary: {} }, { status: 503 })],
      ['a network error', async () => Promise.reject(new TypeError('fetch failed'))],
      ['a client error', async () => detectResponse({ summary: {} }, { status: 402 })],
      [
        'an invalid response',
        async () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
      ],
    ];

    it.each(failures)('sends the request on %s when failing open', async (_name, failure) => {
      const result = await scanTurnDelta(makeScan(), deps(failure));

      expect(result.verdict).toEqual({ action: 'allow' });
      expect(result.charges.every(charge => charge.decision === 'error')).toBe(true);
    });

    it.each(failures)('rejects the request on %s when failing closed', async (_name, failure) => {
      const result = await scanTurnDelta(
        makeScan({ config: { ...config, failMode: 'closed' } }),
        deps(failure)
      );

      expect(result.verdict).toEqual({ action: 'unavailable' });
    });

    it('applies the fail mode when Enkrypt does not answer within the timeout', async () => {
      const hang = (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      const dependencies = deps(hang, { timeoutMs: 20 });

      const open = await scanTurnDelta(makeScan(), dependencies);
      const closed = await scanTurnDelta(
        makeScan({ config: { ...config, failMode: 'closed' } }),
        deps(hang, { timeoutMs: 20 })
      );

      expect(open.verdict).toEqual({ action: 'allow' });
      expect(closed.verdict).toEqual({ action: 'unavailable' });
      expect(dependencies.fetch).toHaveBeenCalledTimes(1);
      expect(open.charges).toEqual([expect.objectContaining({ decision: 'error' })]);
    });

    it('applies the fail mode without calling Enkrypt when the API key is unset', async () => {
      const dependencies = deps(async () => detectResponse({ summary: {} }), {
        apiKey: undefined,
      });

      const result = await scanTurnDelta(
        makeScan({ config: { ...config, failMode: 'closed' } }),
        dependencies
      );

      expect(result).toEqual({ verdict: { action: 'unavailable' }, charges: [] });
      expect(dependencies.fetch).not.toHaveBeenCalled();
    });
  });
});
