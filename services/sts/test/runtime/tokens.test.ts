import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { afterEach, expect, it } from 'vitest';

// Runs STS's token signer and key-set route in local workerd, where each request has its own
// context and Durable Object storage can persist across a restart of the runtime.

type LocalWorker = {
  ready: Promise<void>;
  fetch(url: string): Promise<{ json(): Promise<unknown> }>;
  dispose(): Promise<void>;
};

const CONFIG = fileURLToPath(new URL('../fixtures/runtime/wrangler.jsonc', import.meta.url).href);

/** workerd's warning when a promise is settled after the request that created it ended. */
const CROSS_REQUEST_WARNING = /different request context/;

let workers: LocalWorker[] = [];
let directories: string[] = [];

async function start(persist: string | false, logs: string[] = []): Promise<LocalWorker> {
  const worker = await unstable_startWorker({
    config: CONFIG,
    dev: {
      persist,
      server: { port: 0 },
      inspector: false,
      watch: false,
      logLevel: 'error',
      structuredLogsHandler: (log: { message: string }) => logs.push(log.message),
    },
  });
  await worker.ready;
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(workers.map(worker => worker.dispose()));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  workers = [];
  directories = [];
});

it('keeps the signing key across a restart of the runtime with persisted storage', async () => {
  const persist = mkdtempSync(join(tmpdir(), 'sts-token-signer-'));
  directories.push(persist);

  const first = await start(persist);
  const before = (await (await first.fetch('http://probe.test/token-kid')).json()) as {
    kid: string | null;
  };
  expect(before.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await first.dispose();
  workers = [];

  const second = await start(persist);
  const after = await (await second.fetch('http://probe.test/token-kid')).json();
  expect(after).toEqual(before);
}, 60_000);

it('reads the key set on a cold isolate with one Durable Object call', async () => {
  const persist = mkdtempSync(join(tmpdir(), 'sts-token-key-set-'));
  directories.push(persist);

  // The first runtime builds the key-set document from the four shards and stores it.
  const first = await start(persist);
  const before = await (await first.fetch('http://probe.test/token-kid')).json();
  expect(await (await first.fetch('http://probe.test/key-set-calls')).json()).toEqual({
    keySetRead: 1,
    shardGetJwks: 4,
  });
  await first.dispose();
  workers = [];

  // A new runtime: a cold isolate and cold objects. Its read is one call to the key-set object,
  // which answers from its stored document without calling a shard.
  const second = await start(persist);
  const after = await (await second.fetch('http://probe.test/token-kid')).json();
  expect(after).toEqual(before);
  expect(await (await second.fetch('http://probe.test/key-set-calls')).json()).toEqual({
    keySetRead: 1,
    shardGetJwks: 0,
  });
}, 60_000);

it('answers two cold key-set requests and two cold mint calls each from work of its own', async () => {
  const logs: string[] = [];
  const worker = await start(false, logs);
  const answers = (await (await worker.fetch('http://probe.test/cold-tokens')).json()) as Array<{
    status: number | string;
    kids: string[];
  }>;
  expect(answers.map(answer => answer.status)).toEqual([200, 200, 'ok', 'ok']);
  // Both key-set answers list one key per signer shard; both mints signed under one of them.
  const [first, second, ...mints] = answers;
  expect(new Set(first.kids).size).toBe(4);
  expect(second.kids).toEqual(first.kids);
  for (const mint of mints) expect(first.kids).toContain(mint.kids[0]);
  expect(logs.filter(message => CROSS_REQUEST_WARNING.test(message))).toEqual([]);
}, 60_000);

it('does not let a bound caller read the mint authority over RPC', async () => {
  const worker = await start(false);
  const answer = (await (await worker.fetch('http://probe.test/mint-authority')).json()) as {
    reachable: boolean;
    error: string | null;
  };
  expect(answer.reachable).toBe(false);
  // The method does not exist on the entrypoint (not a failure to serialize its answer).
  expect(answer.error).toBe('The RPC receiver does not implement the method "mintAuthority".');
}, 60_000);
