import { captureException, captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import {
  drainSseStream,
  parseUsageWithRecovery,
  readResponseText,
  selectUsageCostFields,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  VercelProviderMetaData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type { ProviderType } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { createControlledClock } from '@kilocode/web-shared/tests/helpers/timed-body.helper';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const span = { end: () => {} } as Span;

const clock = createControlledClock();
const { bodyArrivingAt } = clock;

beforeEach(() => {
  clock.install();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('drainSseStream', () => {
  test('times SSE events and ignores keep-alive comments', async () => {
    const events: string[] = [];

    const result = await drainSseStream(
      bodyArrivingAt([
        [100, ': OPENROUTER PROCESSING\n\n'],
        [250, 'data: {"choices":[{"delta":{"content":"Hel'],
        [300, 'lo"}}]}\n\n'],
        [800, 'data: {"choices":[],"usage":{}}\n\n'],
        [900, 'data: [DONE]\n\n'],
      ]),
      event => events.push(event.data),
      span,
      20
    );

    expect(events).toEqual([
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '{"choices":[],"usage":{}}',
      '[DONE]',
    ]);
    expect(result).toEqual({
      wasAborted: false,
      malformedEventCount: 0,
      timing: { latency: 280, generation_time: 600 },
    });
  });

  test('times a body without SSE events by its chunks', async () => {
    const result = await drainSseStream(
      bodyArrivingAt([
        [100, '\n'],
        [400, '{"error":{"code":502,'],
        [450, '"message":"Bad gateway"}}'],
      ]),
      () => {},
      span,
      0
    );

    expect(result.timing).toEqual({ latency: 400, generation_time: 50 });
  });

  test('reports no latency without a request start', async () => {
    const result = await drainSseStream(
      bodyArrivingAt([
        [100, 'data: {}\n\n'],
        [150, 'data: [DONE]\n\n'],
      ]),
      () => {},
      span,
      undefined
    );

    expect(result.timing).toEqual({ latency: null, generation_time: 50 });
  });

  test('counts callback failures, parses later events, and reports only ids', async () => {
    jest.mocked(captureException).mockClear();
    jest.mocked(captureMessage).mockClear();

    const stream = bodyArrivingAt([
      [100, 'data: first private event body\n\n'],
      [200, 'data: second private event body\n\n'],
      [300, 'data: valid event\n\n'],
    ]);
    const reader = stream.getReader();
    const cancel = jest.spyOn(reader, 'cancel');
    const releaseLock = jest.spyOn(reader, 'releaseLock');
    const events: string[] = [];
    const endSpan: Span['end'] = jest.fn();

    const result = await drainSseStream(
      { getReader: () => reader } as ReadableStream<Uint8Array>,
      event => {
        if (event.data !== 'valid event') throw new Error(`Invalid event: ${event.data}`);
        events.push(event.data);
      },
      { end: endSpan } as Span,
      0,
      () => ({ usageId: 'usage-id', messageId: 'message-id' })
    );

    expect(result).toMatchObject({ wasAborted: false, malformedEventCount: 2 });
    expect(events).toEqual(['valid event']);
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(endSpan).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('Malformed upstream usage SSE events', {
      level: 'error',
      tags: { source: 'usage_stream_parsing' },
      extra: { usageId: 'usage-id', messageId: 'message-id', malformedEventCount: 2 },
    });
    expect(captureException).not.toHaveBeenCalled();

    stream.getReader().releaseLock();
  });

  test('preserves partial counts and cleans up after a read failure', async () => {
    jest.mocked(captureException).mockClear();
    jest.mocked(captureMessage).mockClear();

    const stream = bodyArrivingAt(
      [[100, 'data: private malformed event body\n\n']],
      new Error('private upstream read error')
    );
    const reader = stream.getReader();
    const cancel = jest.spyOn(reader, 'cancel');
    const releaseLock = jest.spyOn(reader, 'releaseLock');
    const endSpan: Span['end'] = jest.fn();

    const result = await drainSseStream(
      { getReader: () => reader } as ReadableStream<Uint8Array>,
      () => {
        throw new Error('private callback error');
      },
      { end: endSpan } as Span,
      0,
      () => ({ usageId: 'usage-id', messageId: 'message-id' })
    );

    expect(result).toEqual({
      wasAborted: true,
      malformedEventCount: 1,
      timing: { latency: 100, generation_time: 0 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(endSpan).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unable to read upstream usage stream' }),
      {
        tags: { source: 'usage_stream_parsing' },
        extra: { usageId: 'usage-id', messageId: 'message-id' },
      }
    );
    expect(captureMessage).toHaveBeenCalledWith('Malformed upstream usage SSE events', {
      level: 'error',
      tags: { source: 'usage_stream_parsing' },
      extra: { usageId: 'usage-id', messageId: 'message-id', malformedEventCount: 1 },
    });

    stream.getReader().releaseLock();
  });
});

describe('parseUsageWithRecovery', () => {
  const context = {
    api_kind: 'chat_completions',
    kiloUserId: 'user-id',
    organizationId: 'organization-id',
    provider: 'openrouter',
    isStreaming: false,
    usageId: 'usage-id',
  } as MicrodollarUsageContext;

  test('preserves successful stats and fills a missing message id from the header', async () => {
    jest.mocked(captureException).mockClear();

    const stats: MicrodollarUsageStats = {
      messageId: null,
      model: 'test-model',
      responseContent: 'test response',
      hasError: false,
      inference_provider: 'test-provider',
      upstream_id: 'upstream-id',
      finish_reason: 'stop',
      latency: 12,
      moderation_latency: 3,
      generation_time: 45,
      streamed: false,
      cancelled: false,
      status_code: 201,
      cost_mUsd: 25,
      inputTokens: 2,
      outputTokens: 4,
      cacheWriteTokens: 1,
      cacheHitTokens: 3,
      is_byok: false,
    };
    const response = new Response(null, {
      status: 201,
      headers: { 'x-generation-id': 'header-message-id' },
    });

    await expect(parseUsageWithRecovery(response, context, () => stats)).resolves.toEqual({
      ...stats,
      messageId: 'header-message-id',
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  const parserFailures: { name: string; parse: () => null | Promise<null> }[] = [
    {
      name: 'throws with sensitive contents',
      parse: () => {
        throw new Error('private response body');
      },
    },
    { name: 'returns null', parse: () => null },
  ];

  test.each(parserFailures)('returns zeroed stats when the parser $name', async ({ parse }) => {
    jest.mocked(captureException).mockClear();

    const response = new Response('private response body', {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-generation-id': 'header-message-id',
      },
    });

    await expect(parseUsageWithRecovery(response, context, parse)).resolves.toEqual({
      messageId: 'header-message-id',
      model: null,
      responseContent: '',
      hasError: true,
      inference_provider: null,
      upstream_id: null,
      finish_reason: null,
      latency: null,
      moderation_latency: null,
      generation_time: null,
      streamed: false,
      cancelled: null,
      status_code: 503,
      cost_mUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheHitTokens: 0,
      is_byok: null,
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unable to read or parse upstream usage response' }),
      {
        tags: { source: 'usage_response_parsing', api_kind: 'chat_completions' },
        extra: {
          usageId: 'usage-id',
          kiloUserId: 'user-id',
          organizationId: 'organization-id',
          provider: 'openrouter',
          messageId: 'header-message-id',
        },
      }
    );
  });
});

describe('readResponseText', () => {
  test('times a JSON body from its first non-whitespace chunk', async () => {
    const result = await readResponseText(
      bodyArrivingAt([
        [100, '\n \n'],
        [400, '{"id":"gen-1",'],
        [450, '"model":"m"}'],
      ]),
      0
    );

    expect(result).toEqual({
      text: '\n \n{"id":"gen-1","model":"m"}',
      timing: { latency: 400, generation_time: 50 },
    });
  });

  test('reports no timing for an empty body', async () => {
    const result = await readResponseText(bodyArrivingAt([]), 0);

    expect(result).toEqual({ text: '', timing: { latency: null, generation_time: null } });
  });

  test('rejects with the body error', async () => {
    const error = new Error('Response interrupted');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });

    await expect(readResponseText(body, 0)).rejects.toBe(error);
  });
});

describe('selectUsageCostFields', () => {
  const coreProps = {
    messageId: 'test-message-id',
    model: 'test-model',
    responseContent: 'test-response',
    hasError: false,
    inference_provider: 'Provider',
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: 200,
  };

  function vercelGateway(
    costs: { cost?: string; marketCost?: string },
    credentialType?: 'byok' | 'system'
  ): VercelProviderMetaData {
    return {
      gateway: {
        routing: {
          finalProvider: 'anthropic',
          modelAttempts: credentialType
            ? [
                {
                  success: true,
                  providerAttempts: [{ provider: 'anthropic', credentialType, success: true }],
                },
              ]
            : undefined,
        },
        ...costs,
      },
    };
  }

  type Case = {
    name: string;
    usage: Parameters<typeof selectUsageCostFields>[0];
    providerMetadata?: VercelProviderMetaData | null;
    provider?: ProviderType;
    expected: ReturnType<typeof selectUsageCostFields>;
    warns?: boolean;
  };

  const cases: Case[] = [
    {
      name: 'OpenRouter non-BYOK uses usage.cost',
      usage: { cost: 0.001, is_byok: false, cost_details: { upstream_inference_cost: 0.7 } },
      expected: { cost_mUsd: 1000, is_byok: false },
    },
    {
      name: 'OpenRouter BYOK uses upstream_inference_cost',
      usage: { cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } },
      expected: { cost_mUsd: 20000, nonInferenceCost_mUsd: 0, is_byok: true },
    },
    {
      name: 'OpenRouter BYOK charges gateway cost above the fee as non-inference cost',
      usage: { cost: 0.002, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } },
      expected: { cost_mUsd: 21000, nonInferenceCost_mUsd: 1000, is_byok: true },
    },
    {
      name: 'OpenRouter zero cost takes precedence over Vercel metadata',
      usage: { cost: 0, is_byok: false },
      providerMetadata: vercelGateway({ marketCost: '0.5' }, 'byok'),
      expected: { cost_mUsd: 0, is_byok: false },
    },
    {
      name: 'OpenRouter zero cost without is_byok selects OpenRouter with unknown BYOK',
      usage: { cost: 0 },
      providerMetadata: vercelGateway({ marketCost: '0.5' }, 'system'),
      expected: { cost_mUsd: 0, is_byok: null },
    },
    {
      name: 'OpenRouter is_byok without cost still selects OpenRouter',
      usage: { is_byok: false },
      providerMetadata: vercelGateway({ marketCost: '0.5' }),
      expected: { cost_mUsd: 0, is_byok: false },
    },
    {
      name: 'missing is_byok with non-zero cost warns for providers that report it',
      usage: { cost: 0.001, is_byok: null },
      provider: 'openrouter',
      expected: { cost_mUsd: 1000, is_byok: null },
      warns: true,
    },
    {
      name: 'missing is_byok with non-zero cost does not warn for providers that never report it',
      usage: { cost: 0.001 },
      provider: 'direct-byok',
      expected: { cost_mUsd: 1000, is_byok: null },
    },
    {
      name: 'BYOK cost below the 5% fee warns',
      usage: { cost: 0.0005, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } },
      expected: { cost_mUsd: 20000, nonInferenceCost_mUsd: 0, is_byok: true },
      warns: true,
    },
    {
      name: 'Vercel prefers marketCost over cost',
      usage: {},
      providerMetadata: vercelGateway({ cost: '0.5', marketCost: '0.000375' }),
      expected: { cost_mUsd: 375, is_byok: null },
    },
    {
      name: 'Vercel falls back to cost and rounds to microdollars',
      usage: null,
      providerMetadata: vercelGateway({ cost: '0.0962825' }),
      expected: { cost_mUsd: 96283, is_byok: null },
    },
    {
      name: 'Vercel unparseable cost is zero',
      usage: undefined,
      providerMetadata: vercelGateway({ marketCost: 'not-a-number' }, 'system'),
      expected: { cost_mUsd: 0, is_byok: false },
    },
    {
      name: 'Vercel BYOK credential',
      usage: null,
      providerMetadata: vercelGateway({ marketCost: '0.000402' }, 'byok'),
      expected: { cost_mUsd: 402, nonInferenceCost_mUsd: 0, is_byok: true },
    },
    {
      name: 'Vercel system credential',
      usage: null,
      providerMetadata: vercelGateway({ marketCost: '0.000402' }, 'system'),
      expected: { cost_mUsd: 402, is_byok: false },
    },
    {
      name: 'Vercel zero cost still reports the credential type',
      usage: null,
      providerMetadata: vercelGateway({ marketCost: '0' }, 'byok'),
      expected: { cost_mUsd: 0, nonInferenceCost_mUsd: 0, is_byok: true },
    },
    {
      name: 'Vercel metadata without costs falls through to unknown',
      usage: null,
      providerMetadata: vercelGateway({}, 'byok'),
      expected: { cost_mUsd: 0, is_byok: null },
    },
    {
      name: 'no usage and no metadata is zero with unknown BYOK',
      usage: null,
      providerMetadata: null,
      expected: { cost_mUsd: 0, is_byok: null },
    },
  ];

  test.each(cases)(
    '$name',
    ({ usage, providerMetadata = null, provider = 'openrouter', expected, warns = false }) => {
      jest.mocked(captureMessage).mockClear();

      const result = selectUsageCostFields(
        usage,
        providerMetadata,
        coreProps,
        'test_source',
        provider
      );

      expect(result).toEqual(expected);
      if (warns) {
        expect(captureMessage).toHaveBeenCalledWith(
          "SUSPICIOUS: openrouters cost accounting doesn't make sense",
          expect.objectContaining({ tags: { source: 'test_source' } })
        );
      } else {
        expect(captureMessage).not.toHaveBeenCalled();
      }
    }
  );
});
