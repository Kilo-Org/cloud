import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it } from 'vitest';

// Runs STS's broker over a real service binding in local workerd. A Worker entrypoint whose
// method returns an object with a disposer stays open until its caller disposes that object, so
// STS must answer plain data: its context then ends when it returns, whatever the caller does.

/** The part of wrangler's local Worker handle this test uses. */
type LocalWorker = {
  ready: Promise<void>;
  fetch(url: string): Promise<{ json(): Promise<unknown> }>;
  dispose(): Promise<void>;
};

let worker: LocalWorker;

beforeEach(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url).href),
    dev: { server: { port: 0 }, inspector: false, watch: false, logLevel: 'error' },
  });
  await worker.ready;
}, 60_000);

afterEach(async () => {
  await worker.dispose();
});

it('ends the broker call when it returns, though the caller never disposes the result', async () => {
  const reply = await worker.fetch('http://sts.test/read');
  expect(await reply.json()).toEqual({ status: 'ok', brokerOpenAfterReturn: 0 });
}, 30_000);
