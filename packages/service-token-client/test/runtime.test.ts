import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it } from 'vitest';

// Runs the Worker client in local workerd, where each fetch below is its own request. A promise
// or timer created for one request is that request's: when it has ended, workerd cancels its
// timers and drops the continuations of its promises, even ones a later request registered. Plain
// Node cannot show that, so client.test.ts cannot either.

/** How soon after the stand-in answers a waiting read must return; wide enough for a loaded runner. */
const ANSWER_MARGIN_MS = 2_500;

type Call = { tokens: number; answeredAt: number | null };
type ReadReply = { outcome: 'read' | 'error'; tokens?: string[]; at?: number };

/** The part of wrangler's local Worker handle these tests use. */
type LocalWorker = {
  fetch(url: string): Promise<{ json(): Promise<unknown> }>;
  dispose(): Promise<void>;
};

let worker: LocalWorker;
/** What workerd logged; it reports a promise or I/O object used across requests here. */
let workerdLogs: string[];

beforeEach(async () => {
  workerdLogs = [];
  const started = await unstable_startWorker({
    config: fileURLToPath(new URL('./runtime/wrangler.jsonc', import.meta.url)),
    dev: {
      server: { port: 0 },
      inspector: false,
      watch: false,
      logLevel: 'error',
      structuredLogsHandler: (log: { message: string }) => workerdLogs.push(log.message),
    },
  });
  await started.ready;
  worker = started;
}, 60_000);

afterEach(async () => {
  await worker.dispose();
});

async function read(audiences: string): Promise<ReadReply> {
  const reply = await worker.fetch(`http://runtime.test/read?audiences=${audiences}`);
  return (await reply.json()) as ReadReply;
}

async function calls(): Promise<Call[]> {
  return (await (await worker.fetch('http://runtime.test/calls')).json()) as Call[];
}

function expectNoCrossRequestUse(): void {
  expect(workerdLogs.filter(message => /different request/.test(message))).toEqual([]);
}

it('serves two concurrent cold requests from one STS call', async () => {
  await worker.fetch('http://runtime.test/plan?delayMs=1000');

  const replies = await Promise.all([read('web'), read('web')]);
  const [delivered, ...more] = await calls();
  expect(more).toEqual([]);
  expect(delivered).toMatchObject({ tokens: 1, answeredAt: expect.any(Number) });
  for (const reply of replies) {
    expect(reply).toMatchObject({ outcome: 'read', tokens: ['web:sts.canary-token'] });
    expect(reply.at! - delivered.answeredAt!).toBeLessThan(ANSWER_MARGIN_MS);
  }
  expectNoCrossRequestUse();
}, 30_000);

it('mints two audiences one request reads together in one call', async () => {
  await worker.fetch('http://runtime.test/plan?delayMs=500');

  expect(await read('web,usage-ingest')).toMatchObject({
    outcome: 'read',
    tokens: ['web:sts.canary-token', 'usage-ingest:sts.canary-token'],
  });
  expect(await calls()).toEqual([{ tokens: 2, answeredAt: expect.any(Number) }]);
  expectNoCrossRequestUse();
}, 30_000);
