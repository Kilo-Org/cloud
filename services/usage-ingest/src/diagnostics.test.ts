import { afterEach, expect, it, vi } from 'vitest';
import worker from './index';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const send = vi.fn().mockResolvedValue(undefined);
  const metrics = vi.fn();
  const env = {
    USAGE_INGEST_DIAGNOSTICS: 'all',
    USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publisher',
    USAGE_INGEST_QUEUE: { send, sendBatch: vi.fn(), metrics },
    USAGE_INGEST_DLQ: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
    USAGE_WRITER_URL: 'https://writer.invalid/api/internal/usage/record',
    USAGE_WRITER_SECRET: 'synthetic-writer',
    USAGE_WRITER_PROTECTION_BYPASS: 'synthetic-bypass',
  } satisfies Env;
  const logs = () =>
    [info, warn].flatMap(log =>
      log.mock.calls
        .filter(([value]) => typeof value === 'string' && value.startsWith('{'))
        .map(([value]) => JSON.parse(value))
    );
  return { env, send, metrics, info, warn, logs };
}

function publish(env: Env) {
  return worker.fetch(
    new Request('https://publisher.invalid/usage', {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-publisher' },
      body: JSON.stringify(usage),
    }),
    env
  );
}

const absentOrMalformed = [
  undefined,
  null,
  {},
  { metadata: null },
  { metadata: { metrics: null } },
  {
    metadata: {
      metrics: {
        backlogCount: -1,
        backlogBytes: Infinity,
        oldestMessageTimestamp: 'sensitive-unowned-value',
      },
    },
  },
  {
    metadata: {
      metrics: { backlogCount: NaN, backlogBytes: 1.2, oldestMessageTimestamp: new Date(NaN) },
    },
  },
];

it('captures explicit enqueue boundaries and returned metrics without another queue call', async () => {
  const { env, send, metrics, logs } = setup();
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  const accepted = Promise.withResolvers<QueueSendResponse>();
  send.mockReturnValue(accepted.promise);
  const response = publish(env);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(logs()).toEqual([
    {
      level: 'info',
      event: 'usage_ingest_enqueue_start',
      usage_id: usage.core.id,
      publisher_entry_at_ms: 1000,
      before_send_at_ms: 1000,
    },
  ]);
  // Wall-clock movement must not determine elapsed send time.
  vi.spyOn(Date, 'now').mockReturnValue(900);
  clock.mockReturnValue(47);
  accepted.resolve({
    metadata: {
      metrics: { backlogCount: 7, backlogBytes: 120, oldestMessageTimestamp: new Date(500) },
    },
  });
  expect((await response).status).toBe(202);
  expect(logs()[1]).toEqual({
    level: 'info',
    event: 'usage_ingest_enqueue',
    usage_id: usage.core.id,
    outcome: 'accepted',
    publisher_entry_at_ms: 1000,
    before_send_at_ms: 1000,
    after_send_at_ms: 900,
    send_duration_ms: 37,
    queue_backlog_count: 7,
    queue_backlog_bytes: 120,
    queue_oldest_message_at_ms: 500,
  });
  expect(send).toHaveBeenCalledExactlyOnceWith(usage, { contentType: 'json' });
  expect(metrics).not.toHaveBeenCalled();
});

it.each(absentOrMalformed)(
  'keeps accepted publication with optional/malformed metadata %#',
  async response => {
    const { env, send, metrics, logs } = setup();
    send.mockResolvedValue(response);
    expect((await publish(env)).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(metrics).not.toHaveBeenCalled();
    expect(logs()[1]).toMatchObject({ event: 'usage_ingest_enqueue', outcome: 'accepted' });
    expect(logs()[1]).not.toHaveProperty('queue_backlog_count');
    expect(logs()[1]).not.toHaveProperty('queue_backlog_bytes');
    expect(logs()[1]).not.toHaveProperty('queue_oldest_message_at_ms');
  }
);

it.each(['sink', 'metadata'])(
  'never republishes or fails accepted sends on a %s exception',
  async failure => {
    const { env, send, info, logs } = setup();
    if (failure === 'sink')
      info.mockImplementation(() => {
        throw new Error('sensitive-sink');
      });
    else
      send.mockResolvedValue({
        get metadata(): MessageBatchMetadata {
          throw new Error('sensitive-metadata');
        },
      });
    expect((await publish(env)).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    if (failure === 'metadata')
      expect(logs()[1]).toMatchObject({ outcome: 'accepted', usage_id: usage.core.id });
  }
);

it('keeps an enqueue failure a safe 503 even when its diagnostic sink throws', async () => {
  const { env, send, warn } = setup();
  send.mockRejectedValue(new Error('sensitive-queue-error'));
  warn.mockImplementation(() => {
    throw new Error('sensitive-sink');
  });
  const response = await publish(env);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Queue unavailable' });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([undefined, '', 'off', 'true'])(
  'leaves publisher diagnostics off for %s',
  async control => {
    const { env, send, logs } = setup();
    expect((await publish({ ...env, USAGE_INGEST_DIAGNOSTICS: control })).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logs()).toEqual([]);
  }
);

function message() {
  return {
    id: 'synthetic-message',
    timestamp: new Date(100),
    attempts: 2,
    body: usage,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

it('logs entry before writer completion, retains batch/message identity and only safe fields', async () => {
  const { env, logs } = setup();
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const response = Promise.withResolvers<Response>();
  const fetch = vi.fn().mockReturnValue(response.promise);
  vi.stubGlobal('fetch', fetch);
  const messages = [message(), message()];
  const work = worker.queue(
    {
      queue: 'usage-eu',
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      metadata: { metrics: { backlogCount: 9, backlogBytes: 300 } },
    },
    env
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(messages[0].ack).not.toHaveBeenCalled();
  expect(logs()).toEqual([
    expect.objectContaining({
      event: 'usage_ingest_handler_entry',
      queue: 'usage-eu',
      batch_id: expect.any(String),
      batch_size: 2,
      handler_entry_at_ms: 1000,
      message_start_at_ms: 1000,
      message_timestamp_ms: 100,
      queue_message_id: messages[0].id,
      delivery_attempts: 2,
      event_created_at_ms: Date.parse(usage.core.created_at),
      usage_id: usage.core.id,
      queue_backlog_count: 9,
      queue_backlog_bytes: 300,
    }),
  ]);
  // Return a fresh body for the next serial writer call.
  fetch.mockImplementation(() => Promise.resolve(acknowledgement()));
  response.resolve(acknowledgement());
  await work;
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const msg of messages) expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
  expect(new Set(logs().map(log => log.batch_id)).size).toBe(1);
  expect(logs().filter(log => log.event === 'usage_ingest_processing')).toHaveLength(2);
  for (const log of logs()) expect(log.queue).toBe('usage-eu');
  const serialized = JSON.stringify(logs());
  for (const value of [
    'synthetic-publisher',
    'synthetic-writer',
    'synthetic-bypass',
    usage.core.kilo_user_id,
    usage.metadata.user_prompt_prefix,
    'writer.invalid',
  ]) {
    expect(serialized).not.toContain(value);
  }
});

function acknowledgement() {
  return Response.json({
    status: 'recorded',
    result: {
      usageId: usage.core.id,
      createdAt: usage.core.created_at,
      newMicrodollarsUsed: 1234,
    },
  });
}

it.each([200, 429, 503, 400])(
  'preserves ACK/retry and overload outcomes with throwing diagnostics (HTTP %s)',
  async status => {
    const { env, info, warn } = setup();
    for (const log of [info, warn])
      log.mockImplementation(value => {
        if (String(value).startsWith('{')) throw new Error('synthetic-log-failure');
      });
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(status === 200 ? acknowledgement() : new Response(null, { status }))
      );
    vi.stubGlobal('fetch', fetch);
    const msg = message();
    const work = worker.queue(
      {
        queue: 'usage',
        messages: [msg],
        ackAll: vi.fn(),
        retryAll: vi.fn(),
        get metadata(): MessageBatchMetadata {
          throw new Error('synthetic-metadata-failure');
        },
      },
      env
    );
    if (status === 429 || status === 503)
      await expect(work).rejects.toThrow('Usage writer overloaded');
    else await work;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(msg.retry).toHaveBeenCalledTimes(status === 200 ? 0 : 1);
  }
);

it.each(absentOrMalformed)(
  'keeps consumer disposition with optional/malformed batch metadata %#',
  async metadata => {
    const { env } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(acknowledgement()))
    );
    const msg = message();
    await worker.queue(
      {
        queue: 'usage',
        messages: [msg],
        ackAll: vi.fn(),
        retryAll: vi.fn(),
        metadata: {} as MessageBatchMetadata,
        ...(metadata as object),
      } as MessageBatch<unknown>,
      env
    );
    expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
    expect(msg.retry).not.toHaveBeenCalled();
  }
);
