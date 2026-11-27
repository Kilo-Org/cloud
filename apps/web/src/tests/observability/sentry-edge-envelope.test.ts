import { afterAll, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import { createRequire } from 'node:module';
import type * as SentryNextjs from '@sentry/nextjs';
import type { NodeOptions } from '@sentry/nextjs';

type Transport = ReturnType<NonNullable<NodeOptions['transport']>>;
type Envelope = Parameters<Transport['send']>[0];

const sentEnvelopes: Envelope[] = [];

// Fake value only, kept away from the capture call: the SDK can send nearby
// source lines as stack frame context.
const FAKE_QUERY_TOKEN = 'fake-edge-query-token-0000';
const TOKEN_URL = `https://api.example.com/v1/items?access_token=${FAKE_QUERY_TOKEN}`;
// A `sentry-trace` header that asks the server to sample the request.
const SAMPLED_TRACE_HEADER = `${'a'.repeat(32)}-${'b'.repeat(16)}-1`;

// Jest resolves `@sentry/nextjs` to its Node.js build. The edge runtime uses the
// Vercel Edge SDK that `@sentry/nextjs` depends on, so the test loads that SDK
// from the `@sentry/nextjs` package and runs the real edge config on it.
const edge = createRequire(require.resolve('@sentry/nextjs'))(
  '@sentry/vercel-edge'
) as typeof SentryNextjs;

function memoryTransport(): Transport {
  return {
    send: async envelope => {
      sentEnvelopes.push(envelope);
      return {};
    },
    flush: async () => true,
  };
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://fakepublickey@o0.ingest.example.invalid/0';
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@sentry/nextjs', () => ({
      init: (options: NodeOptions) => edge.init({ ...options, transport: memoryTransport }),
    }));
    await import('../../../sentry.edge.config');
  });
});

afterAll(async () => {
  await edge.close(2000);
});

beforeEach(() => {
  sentEnvelopes.length = 0;
});

test('an edge envelope carries no span name in its trace header', async () => {
  edge.withIsolationScope(() => {
    edge.startSpan({ name: `GET ${TOKEN_URL}`, forceTransaction: true }, () => {
      edge.captureException(new Error('edge request failed'));
    });
  });
  await edge.flush(2000);

  const types = sentEnvelopes.flatMap(([, items]) => items.map(([header]) => header.type));
  expect(types).toContain('event');
  expect(JSON.stringify(sentEnvelopes)).not.toContain(FAKE_QUERY_TOKEN);
});

test('an edge request with a sampled incoming trace builds no transaction', async () => {
  edge.withIsolationScope(() => {
    edge.continueTrace({ sentryTrace: SAMPLED_TRACE_HEADER, baggage: undefined }, () => {
      edge.startSpan({ name: 'GET /api/models', forceTransaction: true }, () => {
        edge.captureException(new Error('traced edge request failed'));
      });
    });
  });
  await edge.flush(2000);

  const types = sentEnvelopes.flatMap(([, items]) => items.map(([header]) => header.type));
  expect(types).toContain('event');
  expect(types).not.toContain('transaction');
  expect(types).not.toContain('span');
});

test('an edge request sends no span even when the sampler would sample one', async () => {
  const options = edge.getClient()?.getOptions();
  const sampler = options?.tracesSampler;
  if (options) options.tracesSampler = () => 1;
  try {
    edge.withIsolationScope(() => {
      edge.startSpan({ name: 'GET /api/models', forceTransaction: true }, () => {
        edge.captureException(new Error('sampled edge request failed'));
      });
    });
    await edge.flush(2000);
  } finally {
    if (options) options.tracesSampler = sampler;
  }

  const types = sentEnvelopes.flatMap(([, items]) => items.map(([header]) => header.type));
  expect(types).toContain('event');
  expect(types).not.toContain('transaction');
  expect(types).not.toContain('span');
});
