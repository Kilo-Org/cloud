import { STS_USAGE_RECORD, type MintRequest, type MintResult } from '@kilocode/sts-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';
import { writerAuthMode } from './writer-auth';

const WRITER_SECRET = 'synthetic-writer-secret';
const RECORD_TOKEN = 'synthetic.record.token';

function message(id = 'queue-1') {
  return { id, timestamp: new Date(), attempts: 1, body: usage, ack: vi.fn(), retry: vi.fn() };
}

function batch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue: 'usage',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } as unknown as MessageBatch<unknown>;
}

function context(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

function binding(answer: (request: MintRequest) => MintResult | Promise<MintResult>) {
  return { mintTokens: vi.fn(async (request: MintRequest) => answer(request)) };
}

function issued(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued',
      audience,
      scope,
      token: RECORD_TOKEN,
      jti: 'jti-1',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

function denied(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'denied',
      audience,
      scope,
      reason: 'scope_not_allowed',
    })),
  };
}

function setup(overrides: Partial<Env>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      status: 'recorded',
      result: { usageId: usage.core.id, createdAt: usage.core.created_at, newMicrodollarsUsed: 1 },
    })
  );
  vi.stubGlobal('fetch', fetch);
  const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')];
  logs.forEach(log => log.mockImplementation(() => {}));
  const lines = () =>
    logs.flatMap(log =>
      log.mock.calls
        .filter(([value]) => typeof value === 'string' && value.startsWith('{'))
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
    );
  const env = {
    USAGE_WRITER_URL: 'https://writer.test/api/internal/usage/record',
    USAGE_WRITER_SECRET: WRITER_SECRET,
    ...overrides,
  } as Env;
  const sentHeaders = () =>
    fetch.mock.calls.map(([, init]) => Object.fromEntries(new Headers(init?.headers)));
  const processing = () => lines().filter(line => line.event === 'usage_ingest_processing');
  const credentialWarnings = () =>
    lines().filter(line => line.event === 'usage_ingest_writer_credential_unavailable');
  return { env, fetch, sentHeaders, processing, credentialWarnings };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Retried (never acknowledged), with no writer request, for `reason`. */
async function expectRetriedWithoutWrite(
  overrides: Partial<Env>,
  reason: string,
  messages = [message()]
) {
  const { env, fetch, processing } = setup(overrides);
  await worker.queue(batch(messages), env, context());
  for (const each of messages) {
    expect(each.ack).not.toHaveBeenCalled();
    expect(each.retry).toHaveBeenCalledOnce();
  }
  expect(fetch).not.toHaveBeenCalled();
  for (const line of processing()) expect(line).toMatchObject({ reason, queue_action: 'retry' });
}

describe('writerAuthMode', () => {
  it('defaults to legacy, knows sts and nothing else', () => {
    expect(writerAuthMode(undefined)).toBe('legacy');
    expect(writerAuthMode('legacy')).toBe('legacy');
    expect(writerAuthMode('sts')).toBe('sts');
    for (const value of ['', 'dual', 'STS', 'true']) expect(writerAuthMode(value)).toBeNull();
  });
});

describe('usage writer credential', () => {
  it('sends only the writer secret by default and never asks STS', async () => {
    const sts = binding(issued);
    const { env, sentHeaders } = setup({ STS: sts });
    const delivered = message();
    await worker.queue(batch([delivered]), env, context());
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(sentHeaders()).toEqual([
      {
        'content-type': 'application/json',
        'x-internal-api-key': WRITER_SECRET,
        'x-usage-write-source': 'queue',
      },
    ]);
    expect(sts.mintTokens).not.toHaveBeenCalled();
  });

  it('sends only an STS_USAGE_RECORD token under sts, never the secret', async () => {
    const sts = binding(issued);
    const { env, sentHeaders } = setup({ STS: sts, USAGE_WRITER_AUTH: 'sts' });
    const delivered = [message(), message('queue-2')];
    await worker.queue(batch(delivered), env, context());
    for (const each of delivered) expect(each.ack).toHaveBeenCalledOnce();
    expect(sentHeaders()).toHaveLength(2);
    for (const headers of sentHeaders()) {
      expect(headers).not.toHaveProperty('x-internal-api-key');
      expect(headers).toMatchObject({
        authorization: `Bearer ${RECORD_TOKEN}`,
        'x-usage-write-source': 'queue',
      });
    }
    // One mint serves the batch: the second write reuses the isolate's token.
    expect(sts.mintTokens).toHaveBeenCalledOnce();
    expect(sts.mintTokens).toHaveBeenCalledWith({ tokens: [STS_USAGE_RECORD] });
  });

  it('retries without writing when STS denies the token, logging once per batch', async () => {
    const messages = [message(), message('queue-2')];
    await expectRetriedWithoutWrite(
      { STS: binding(denied), USAGE_WRITER_AUTH: 'sts' },
      'writer_token_unavailable',
      messages
    );
  });

  it('logs the denial reason once per batch', async () => {
    const { env, credentialWarnings } = setup({ STS: binding(denied), USAGE_WRITER_AUTH: 'sts' });
    await worker.queue(batch([message(), message('queue-2')]), env, context());
    expect(credentialWarnings()).toEqual([
      expect.objectContaining({ reason: 'denied', denied_reason: 'scope_not_allowed' }),
    ]);
  });

  it('retries without writing when STS is unavailable or the binding fails', async () => {
    await expectRetriedWithoutWrite(
      {
        STS: binding(() => ({ status: 'unavailable', retryAfterSeconds: 5 })),
        USAGE_WRITER_AUTH: 'sts',
      },
      'writer_token_unavailable'
    );
    await expectRetriedWithoutWrite(
      {
        STS: binding(() => Promise.reject(new Error('binding failed'))),
        USAGE_WRITER_AUTH: 'sts',
      },
      'writer_token_unavailable'
    );
  });

  it('retries without writing when sts has no STS binding', async () => {
    await expectRetriedWithoutWrite({ USAGE_WRITER_AUTH: 'sts' }, 'writer_token_unavailable');
  });

  it('retries without writing for an unknown mode, never falling back to the secret', async () => {
    await expectRetriedWithoutWrite(
      { STS: binding(issued), USAGE_WRITER_AUTH: 'dual' },
      'writer_auth_misconfigured'
    );
  });

  it('starts no write when a slow mint spends the launch budget', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const slow = binding(request => {
      // The invocation's last launch is 660 s after its start.
      now += 700_000;
      return issued(request);
    });
    await expectRetriedWithoutWrite({ STS: slow, USAGE_WRITER_AUTH: 'sts' }, 'invocation_budget');
    expect(slow.mintTokens).toHaveBeenCalledOnce();
  });
});
