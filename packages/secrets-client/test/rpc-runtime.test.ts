import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it } from 'vitest';

// Runs the Worker client over a real service binding in local workerd. A Worker entrypoint that
// returns another RPC call's result, as STS's SecretsBroker does, stays open until the caller
// disposes what it received; a caller that never does keeps its own request running too.

/** The part of wrangler's local Worker handle this test uses. */
type LocalWorker = {
  fetch(url: string): Promise<{ json(): Promise<unknown> }>;
  dispose(): Promise<void>;
};

let worker: LocalWorker;

beforeEach(async () => {
  const started = await unstable_startWorker({
    config: fileURLToPath(new URL('./runtime/rpc/wrangler.jsonc', import.meta.url)),
    dev: { server: { port: 0 }, inspector: false, watch: false, logLevel: 'error' },
  });
  await started.ready;
  worker = started;
}, 60_000);

afterEach(async () => {
  await worker.dispose();
});

it('closes the STS call as soon as the bundle is read', async () => {
  const reply = await worker.fetch('http://rpc.test/read');
  expect(await reply.json()).toEqual({ value: 'ae-token', brokerOpenAfterReturn: 0 });
}, 30_000);
