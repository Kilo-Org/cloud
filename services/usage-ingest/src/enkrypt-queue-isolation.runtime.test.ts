import { createServer, type RequestListener } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { createTestHarness } from 'wrangler';
import { describe, expect, it, vi } from 'vitest';
import { enkryptMessage, enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaMessage, exaRecord } from './exa-usage.test-fixture';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';

const publishSecret = 'synthetic-isolation-publisher';
const writerSecret = 'synthetic-isolation-writer';

const ENKRYPT_PATH = '/api/internal/enkrypt-usage/record';
const EXA_PATH = '/api/internal/exa-usage/record';
const LLM_PATH = '/api/internal/usage/record';

type WriterCall = { path: string | undefined; body: { id?: string; core?: { id: string } } };
type Processing = {
  queue: string;
  batch_id: string;
  usage_id?: string;
  usage_kind?: string;
  queue_action: string;
  outcome: string;
  reason?: string;
  invocation_failure?: string;
};

const queues = {
  production: {
    shared: 'usage-ingest-processing-eu',
    hedge: 'usage-ingest-processing',
    tagged: 'usage-ingest-enkrypt-eu',
  },
  staging: {
    shared: 'usage-ingest-processing-staging-eu',
    hedge: 'usage-ingest-processing-staging',
    tagged: 'usage-ingest-enkrypt-staging-eu',
  },
} as const;

/**
 * Runs the committed wrangler.jsonc (producers, consumers, bindings and the LLM stall hedge, which
 * stays on) in local workerd. The writer is a loopback HTTP stub: it proves the writer protocol and
 * identity on each call, not a database write or hosted Cloudflare autoscaling.
 *
 * A slow runner can make an LLM send exceed the hedge delay and add a hedge copy on the global
 * queue. LLM assertions therefore count only the shared EU queue; tagged usage must never appear on
 * the hedge queue, whatever the timing.
 */
async function withRuntime(
  environment: 'production' | 'staging',
  dedicatedSwitch: string | undefined,
  handleWrite: RequestListener,
  run: (runtime: {
    publish: (path: string, body: unknown) => Promise<Response>;
    processing: () => Processing[];
    env: () => Promise<Env>;
  }) => Promise<void>
) {
  const writer = createServer(handleWrite);
  let harness: ReturnType<typeof createTestHarness> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject);
      writer.listen(0, '127.0.0.1', resolve);
    });
    const address = writer.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback writer address');
    const server = createTestHarness({
      workers: [
        {
          configPath: new URL('../wrangler.jsonc', import.meta.url),
          ...(environment === 'staging' ? { env: 'staging' } : {}),
          vars: {
            USAGE_WRITER_URL: `http://127.0.0.1:${address.port}${LLM_PATH}`,
          },
          // The cutover switch is a secret binding in the runbook, so it is supplied the same way.
          secrets: {
            USAGE_INGEST_PUBLISH_SECRET: publishSecret,
            USAGE_WRITER_SECRET: writerSecret,
            ...(dedicatedSwitch === undefined
              ? {}
              : { USAGE_INGEST_DEDICATED_TAGGED_QUEUE_ENABLED: dedicatedSwitch }),
          },
        },
      ],
    });
    harness = server;
    const { url } = await server.listen();
    const env = () => server.getWorker<Env>().getEnv();
    expect((await env()).USAGE_INGEST_HEDGE_MODE).toBe('on');
    await run({
      publish: (path, body) =>
        fetch(new URL(path, url), {
          method: 'POST',
          headers: { Authorization: `Bearer ${publishSecret}` },
          body: JSON.stringify(body),
        }),
      processing: () =>
        server
          .getLogs()
          .filter(log => log.message.includes('"usage_ingest_processing"'))
          .map(log => JSON.parse(log.message) as Processing),
      env,
    });
    const logged = JSON.stringify(server.getLogs());
    for (const sensitive of [
      publishSecret,
      writerSecret,
      enkryptRecord.kiloUserId,
      enkryptRecord.sessionId,
      enkryptRecord.organizationId,
      exaRecord.userId,
      exaRecord.organizationId,
    ])
      expect(logged).not.toContain(sensitive);
  } finally {
    try {
      await harness?.close();
    } finally {
      writer.closeAllConnections();
      if (writer.listening) {
        await new Promise<void>((resolve, reject) =>
          writer.close(error => (error ? reject(error) : resolve()))
        );
      }
    }
  }
}

type TaggedReply = (
  path: string,
  id: string,
  occurredAt: string
) => { status: number; body: object };

/** Models both tagged writers' conflict key: the pair of id and occurredAt. */
function dedupingReply(): TaggedReply {
  const recorded = new Set<string>();
  return (path, id, occurredAt) => {
    const key = `${path}|${id}|${occurredAt}`;
    const status = recorded.has(key) ? 'duplicate' : 'recorded';
    recorded.add(key);
    return { status: 200, body: { status, usageId: id } };
  };
}

function recordingWriter(calls: WriterCall[], taggedReply: TaggedReply): RequestListener {
  return async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    calls.push({ path: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === LLM_PATH) {
      response.end(
        JSON.stringify({
          status: 'recorded',
          result: {
            usageId: body.core.id,
            createdAt: body.core.created_at,
            newMicrodollarsUsed: 1,
          },
        })
      );
      return;
    }
    const reply = taggedReply(String(request.url), body.id, body.occurredAt);
    response.statusCode = reply.status;
    response.end(JSON.stringify(reply.body));
  };
}

function bodiesAt(calls: WriterCall[], path: string) {
  return calls.filter(call => call.path === path).map(call => call.body);
}

describe.each(['production', 'staging'] as const)('%s queue routing', environment => {
  it('with the switch on, publishes Enkrypt and Exa only to the tagged queue, never hedged, while LLM keeps the shared queue', async () => {
    const calls: WriterCall[] = [];
    await withRuntime(
      environment,
      'true',
      recordingWriter(calls, dedupingReply()),
      async runtime => {
        const { publish, processing } = runtime;
        expect((await publish('/enkrypt-usage', enkryptRecord)).status).toBe(202);
        expect((await publish('/exa-usage', exaRecord)).status).toBe(202);
        expect((await publish('/usage', usage)).status).toBe(202);
        // Envelope or wrong-kind bodies are still rejected by the unchanged validation.
        expect((await publish('/enkrypt-usage', enkryptMessage)).status).toBe(400);
        expect((await publish('/exa-usage', exaMessage)).status).toBe(400);
        expect((await publish('/exa-usage', enkryptRecord)).status).toBe(400);

        const onShared = (id: string) =>
          processing().filter(
            log => log.usage_id === id && log.queue === queues[environment].shared
          );
        await vi.waitFor(
          () => {
            const ids = processing().map(log => log.usage_id);
            expect(ids).toContain(enkryptRecord.id);
            expect(ids).toContain(exaRecord.id);
            expect(onShared(usage.core.id)).toHaveLength(1);
          },
          { timeout: 15_000 }
        );
        // Past the 1 s hedge delay, so a tagged hedge copy would have been sent and consumed.
        await setTimeout(1_500);

        for (const [id, kind] of [
          [enkryptRecord.id, 'enkrypt_usage'],
          [exaRecord.id, 'exa_usage'],
        ] as const) {
          const lines = processing().filter(log => log.usage_id === id);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatchObject({
            queue: queues[environment].tagged,
            usage_kind: kind,
            outcome: 'recorded',
            queue_action: 'ack',
          });
        }
        expect(onShared(usage.core.id)[0]).toMatchObject({ queue_action: 'ack' });
        // Any further LLM line can only be the LLM hedge copy on the global queue.
        for (const log of processing().filter(log => log.usage_id === usage.core.id))
          expect([queues[environment].shared, queues[environment].hedge]).toContain(log.queue);
        expect(bodiesAt(calls, ENKRYPT_PATH)).toEqual([enkryptRecord]);
        expect(bodiesAt(calls, EXA_PATH)).toEqual([exaRecord]);
      }
    );
  }, 45_000);
});

it('keeps tagged writer overload out of the invocation that records LLM usage', async () => {
  const calls: WriterCall[] = [];
  const unavailable: TaggedReply = () => ({
    status: 503,
    body: { error: 'Usage writer unavailable' },
  });
  const ids = [
    '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01',
    '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c02',
    '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c03',
  ];
  await withRuntime('production', 'true', recordingWriter(calls, unavailable), async runtime => {
    const { publish, processing } = runtime;
    const responses = await Promise.all([
      publish('/enkrypt-usage', { ...enkryptRecord, id: ids[0] }),
      publish('/enkrypt-usage', { ...enkryptRecord, id: ids[1] }),
      publish('/exa-usage', { ...exaRecord, id: ids[2] }),
      publish('/usage', usage),
    ]);
    expect(responses.map(response => response.status)).toEqual([202, 202, 202, 202]);

    const llmShared = () =>
      processing().filter(
        log => log.usage_id === usage.core.id && log.queue === queues.production.shared
      );
    await vi.waitFor(
      () => {
        const seen = processing().map(log => log.usage_id);
        for (const id of ids) expect(seen).toContain(id);
        expect(llmShared()).toHaveLength(1);
      },
      { timeout: 15_000 }
    );
    const logs = processing();
    const tagged = logs.filter(log => log.usage_kind !== undefined);

    // Every first tagged delivery is an overload retry on the tagged queue.
    expect(tagged.map(log => log.usage_kind).toSorted()).toEqual([
      'enkrypt_usage',
      'enkrypt_usage',
      'exa_usage',
    ]);
    expect(tagged.every(log => log.queue === queues.production.tagged)).toBe(true);
    expect(tagged.every(log => log.queue_action === 'retry')).toBe(true);
    expect(tagged.every(log => log.invocation_failure === 'writer_overloaded')).toBe(true);

    const [llm] = llmShared();
    expect(llm).toMatchObject({ queue_action: 'ack' });
    // No overloaded sibling shared the LLM invocation, so nothing makes it throw.
    const llmBatch = logs.filter(log => log.batch_id === llm.batch_id);
    expect(llmBatch.every(log => log.usage_kind === undefined)).toBe(true);
    expect(llmBatch.some(log => log.invocation_failure !== undefined)).toBe(false);
  });
}, 45_000);

it('settles each tagged identity once across a legacy shared copy and tagged-queue copies', async () => {
  const calls: WriterCall[] = [];
  await withRuntime(
    'production',
    'true',
    recordingWriter(calls, dedupingReply()),
    async runtime => {
      const { publish, processing, env } = runtime;
      // Messages the previous Worker version already queued on the shared queue.
      const shared = (await env()).USAGE_INGEST_QUEUE;
      await shared.send(enkryptMessage, { contentType: 'json' });
      await shared.send(exaMessage, { contentType: 'json' });
      await vi.waitFor(() => expect(processing()).toHaveLength(2), { timeout: 15_000 });
      for (const [id, kind] of [
        [enkryptRecord.id, 'enkrypt_usage'],
        [exaRecord.id, 'exa_usage'],
      ] as const)
        expect(processing().find(log => log.usage_id === id)).toMatchObject({
          queue: queues.production.shared,
          usage_kind: kind,
          outcome: 'recorded',
          queue_action: 'ack',
        });

      // Producers resend the same usage id after an ambiguous publish; it now lands tagged.
      for (const [path, record] of [
        ['/enkrypt-usage', enkryptRecord],
        ['/exa-usage', exaRecord],
        ['/enkrypt-usage', enkryptRecord],
        ['/exa-usage', exaRecord],
      ] as const)
        expect((await publish(path, record)).status).toBe(202);
      await vi.waitFor(() => expect(processing()).toHaveLength(6), { timeout: 15_000 });
      for (const log of processing().slice(2))
        expect(log).toMatchObject({
          queue: queues.production.tagged,
          outcome: 'duplicate',
          queue_action: 'ack',
        });

      // Legacy messages that are not valid tagged envelopes still retry without a write.
      for (const invalid of [
        { ...enkryptMessage, record: { ...enkryptRecord, id: 'not-a-uuid' } },
        { ...exaMessage, record: { ...exaRecord, id: 'not-a-uuid' } },
      ])
        await shared.send(invalid as never, { contentType: 'json' });
      await vi.waitFor(() => expect(processing()).toHaveLength(8), { timeout: 15_000 });
      for (const log of processing().slice(6))
        expect(log).toMatchObject({
          queue: queues.production.shared,
          outcome: 'unavailable',
          reason: 'invalid_event',
          queue_action: 'retry',
        });
      await setTimeout(250);
      expect(bodiesAt(calls, ENKRYPT_PATH)).toEqual([enkryptRecord, enkryptRecord, enkryptRecord]);
      expect(bodiesAt(calls, EXA_PATH)).toEqual([exaRecord, exaRecord, exaRecord]);
      expect(bodiesAt(calls, LLM_PATH)).toEqual([]);
    }
  );
}, 45_000);

describe.each([
  ['production', undefined],
  ['staging', 'false'],
  ['production', 'TRUE'],
] as const)('%s with the switch %s', (environment, dedicatedSwitch) => {
  it('keeps both tagged routes on the shared queue, never hedged, while the tagged consumer still drains', async () => {
    const calls: WriterCall[] = [];
    await withRuntime(
      environment,
      dedicatedSwitch,
      recordingWriter(calls, dedupingReply()),
      async runtime => {
        const { publish, processing, env } = runtime;
        expect((await publish('/enkrypt-usage', enkryptRecord)).status).toBe(202);
        expect((await publish('/exa-usage', exaRecord)).status).toBe(202);
        // Accepted earlier while the switch was on: rollback keeps the tagged consumer attached.
        const drained = { ...enkryptRecord, id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c09' };
        await (
          await env()
        ).USAGE_INGEST_ENKRYPT_QUEUE.send(
          { ...enkryptMessage, record: drained },
          { contentType: 'json' }
        );
        await vi.waitFor(() => expect(processing()).toHaveLength(3), { timeout: 15_000 });
        // Past the 1 s hedge delay, so a tagged hedge copy would have been sent and consumed.
        await setTimeout(1_500);

        expect(processing()).toHaveLength(3);
        for (const [id, kind] of [
          [enkryptRecord.id, 'enkrypt_usage'],
          [exaRecord.id, 'exa_usage'],
        ] as const)
          expect(processing().find(log => log.usage_id === id)).toMatchObject({
            queue: queues[environment].shared,
            usage_kind: kind,
            outcome: 'recorded',
            queue_action: 'ack',
          });
        expect(processing().find(log => log.usage_id === drained.id)).toMatchObject({
          queue: queues[environment].tagged,
          outcome: 'recorded',
          queue_action: 'ack',
        });
        // The two consumers run independently, so their writer calls can arrive in either order.
        expect(bodiesAt(calls, ENKRYPT_PATH)).toHaveLength(2);
        expect(bodiesAt(calls, ENKRYPT_PATH)).toEqual(
          expect.arrayContaining([enkryptRecord, drained])
        );
        expect(bodiesAt(calls, EXA_PATH)).toEqual([exaRecord]);
      }
    );
  }, 45_000);
});
