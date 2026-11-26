import { fileURLToPath } from 'node:url';
import type { BundleResult } from '@kilocode/sts-contracts';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// These tests run the client in local workerd, where each fetch below is its own request. A
// promise or timer created for one request is that request's: when the request has ended,
// workerd cancels its timers and drops the continuations of its promises, even ones that a later
// request registered. Plain Node cannot show that, so client.test.ts cannot either.

const ETAG = '"0123456789abcdef"';
const OK: BundleResult = {
  status: 'ok',
  workload: 'o11y',
  environment: 'production',
  etag: ETAG,
  stale: false,
  fetchedAt: '2026-11-25T00:00:00.000Z',
  secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 1 } },
  missing: [],
};
const NOT_MODIFIED: BundleResult = {
  status: 'not_modified',
  etag: ETAG,
  stale: false,
  fetchedAt: OK.fetchedAt,
};

/**
 * How soon after the stand-in answers a waiting read must return: well under the 5 s attempt
 * timeout the old code slept through, wide enough for a loaded CI runner.
 */
const ANSWER_MARGIN_MS = 2_500;

type Step = { result: BundleResult; delayMs: number };
type Call = {
  ifNoneMatch: string | null;
  status: BundleResult['status'];
  answeredAt: number | null;
};
type ReadReply = { outcome: 'read' | 'error' | 'gave_up'; value?: string; at?: number };

/** The part of wrangler's local Worker handle these tests use. */
type LocalWorker = {
  fetch(
    url: string,
    init?: { method: string; body: string }
  ): Promise<{ json(): Promise<unknown> }>;
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

function expectNoCrossRequestUse(): void {
  expect(workerdLogs.filter(message => /different request/.test(message))).toEqual([]);
}

async function plan(steps: Step[]): Promise<void> {
  await worker.fetch('http://runtime.test/plan', { method: 'POST', body: JSON.stringify(steps) });
}

async function calls(): Promise<Call[]> {
  return (await (await worker.fetch('http://runtime.test/calls')).json()) as Call[];
}

async function read(query = ''): Promise<ReadReply> {
  return (await (await worker.fetch(`http://runtime.test/read${query}`)).json()) as ReadReply;
}

/** Ages the held bundle past the 240 s revalidation age; the next read revalidates. */
async function expectRevalidationWithEtag(callsBefore: number): Promise<void> {
  await worker.fetch('http://runtime.test/clock?advanceMs=241000');
  expect(await read()).toMatchObject({ outcome: 'read', value: 'ae-token' });
  // The revalidation runs in the background of that read, inside workerd, so the test polls
  // the stand-in's record of calls instead of awaiting it.
  await vi.waitFor(
    async () => expect((await calls())[callsBefore]?.answeredAt).toEqual(expect.any(Number)),
    { timeout: 5_000, interval: 50 }
  );
  expect((await calls())[callsBefore]).toMatchObject({ ifNoneMatch: ETAG, status: 'not_modified' });
}

it('returns on its own answer when an ended request settled the attempt before it', async () => {
  await plan([
    { result: { status: 'unavailable', reason: 'internal', retryAfterSeconds: 1 }, delayMs: 0 },
    { result: OK, delayMs: 0 },
    { result: NOT_MODIFIED, delayMs: 0 },
  ]);

  // The first request meets a failed attempt and ends while the client backs off.
  expect(await read('?giveUpMs=200')).toEqual({ outcome: 'gave_up' });

  // The second request waits out the backoff and loads the bundle itself.
  const second = await read();
  expect(second).toMatchObject({ outcome: 'read', value: 'ae-token' });
  const [failed, delivered] = await calls();
  expect(failed).toMatchObject({ ifNoneMatch: null, status: 'unavailable' });
  expect(delivered).toMatchObject({ ifNoneMatch: null, status: 'ok' });
  // It returns when that answer lands, not when its 5 s attempt deadline passes.
  expect(second.at! - delivered.answeredAt!).toBeLessThan(ANSWER_MARGIN_MS);

  await expectRevalidationWithEtag(2);
  expect((await calls()).filter(c => c.status === 'ok')).toHaveLength(1);
  expectNoCrossRequestUse();
}, 30_000);

it('takes over a read whose request ended before STS answered, then revalidates', async () => {
  await plan([
    { result: OK, delayMs: 1_000 },
    { result: OK, delayMs: 0 },
    { result: NOT_MODIFIED, delayMs: 0 },
  ]);

  // The first request starts the load and ends before the answer, so that answer never lands.
  expect(await read('?giveUpMs=200')).toEqual({ outcome: 'gave_up' });

  // The second request waits out that attempt's 5 s deadline and backoff, then loads again.
  const second = await read();
  expect(second).toMatchObject({ outcome: 'read', value: 'ae-token' });
  const [abandoned, delivered] = await calls();
  expect(abandoned).toMatchObject({ ifNoneMatch: null, answeredAt: null });
  expect(delivered).toMatchObject({ ifNoneMatch: null, status: 'ok' });
  expect(second.at! - delivered.answeredAt!).toBeLessThan(ANSWER_MARGIN_MS);

  // Its answer reached the shared cache: the next STS call is a conditional one.
  await expectRevalidationWithEtag(2);
  expectNoCrossRequestUse();
}, 40_000);

it('serves two live requests from one attempt', async () => {
  await plan([{ result: OK, delayMs: 1_000 }]);

  // One request starts the load; the other finds it running and waits on the shared cache.
  const replies = await Promise.all([read(), read()]);
  const [delivered, ...more] = await calls();
  expect(more).toEqual([]);
  expect(delivered).toMatchObject({ ifNoneMatch: null, status: 'ok' });
  for (const reply of replies) {
    expect(reply).toMatchObject({ outcome: 'read', value: 'ae-token' });
    expect(reply.at! - delivered.answeredAt!).toBeLessThan(ANSWER_MARGIN_MS);
  }
  expectNoCrossRequestUse();
}, 30_000);
