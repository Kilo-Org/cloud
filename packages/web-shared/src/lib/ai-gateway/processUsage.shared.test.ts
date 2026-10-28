import { captureMessage } from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import {
  drainSseStream,
  readResponseText,
  selectUsageCostFields,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import type { VercelProviderMetaData } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type { ProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { createControlledClock } from '@kilocode/web-shared/tests/helpers/timed-body.helper';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
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
    provider?: ProviderId;
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
      provider: 'martian',
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
