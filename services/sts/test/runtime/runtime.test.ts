import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { afterEach, beforeEach, expect, it } from 'vitest';

// Runs STS in local workerd, where each fetch is its own request with its own context. Plain Node
// and the Workers test pool cannot show what these check: when a request's context ends, workerd
// cancels its timers and its pending calls, even ones another request is waiting on.

/** The part of wrangler's local Worker handle these tests use. */
type LocalWorker = {
  ready: Promise<void>;
  fetch(url: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> }>;
  dispose(): Promise<void>;
};

/** Calls into the racers' slow dependency: how many started and how many answered. */
type Calls = { started: number; completed: number };

/** What the fixture's `/race` answers: the cancelled racer, then the second one. */
type Race = {
  first: number | string;
  second: number | string;
  body: string;
  secondMs: number;
  calls: Calls;
};

/** What the fixture's `/fill` answers. */
type Fill = { status: string; secrets: unknown; ms: number; fillsBuilt: number };

/** workerd's warning when a promise is settled after the request that created it ended. */
const CROSS_REQUEST_WARNING = /different request context/;

/** Each racer's slow call takes 500 ms; the second racer must not wait for the cancelled one. */
const PROMPT_MS = 2_000;

/** The fixture refresher takes this long to build a bundle for an empty bundle object. */
const SLOW_FILL_MS = 1_000;

let worker: LocalWorker;
/** Everything workerd logged during the test. */
let workerdLogs: string[];

beforeEach(async () => {
  workerdLogs = [];
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../fixtures/runtime/wrangler.jsonc', import.meta.url).href),
    dev: {
      // Every test starts from empty Durable Objects.
      persist: false,
      server: { port: 0 },
      inspector: false,
      watch: false,
      logLevel: 'error',
      structuredLogsHandler: (log: { message: string }) => workerdLogs.push(log.message),
    },
  });
  await worker.ready;
}, 60_000);

afterEach(async () => {
  await worker.dispose();
});

async function race(route: string): Promise<Race> {
  const reply = await worker.fetch(`http://probe.test/race?route=${route}`);
  return (await reply.json()) as Race;
}

async function fill(query = ''): Promise<Fill> {
  const reply = await worker.fetch(`http://probe.test/fill${query}`);
  return (await reply.json()) as Fill;
}

it('ends the broker call when it returns, though the caller never disposes the result', async () => {
  const reply = await worker.fetch('http://probe.test/read');
  expect(await reply.json()).toEqual({ status: 'ok', brokerOpenAfterReturn: 0 });
}, 30_000);

it('captures the warning workerd logs for a promise settled across requests (control)', async () => {
  // Shows the warning checks below can fail: this settles a promise its creator left behind.
  expect(await (await worker.fetch('http://probe.test/strand')).text()).toBe('stranded');
  expect(await (await worker.fetch('http://probe.test/settle')).text()).toBe('settled');
  await expect
    .poll(() => workerdLogs.some(message => CROSS_REQUEST_WARNING.test(message)))
    .toBe(true);
}, 30_000);

it('lets a fill that outlives the deadline finish in the bundle object and serve the next read', async () => {
  // STS stops waiting after 100 ms and its request ends, cancelling the call on STS's side.
  const early = await fill('?deadlineMs=100');
  expect(early).toMatchObject({ status: 'unavailable', secrets: null, fillsBuilt: 0 });
  expect(early.ms).toBeLessThan(SLOW_FILL_MS);

  // The fill goes on inside the bundle object after STS stopped waiting.
  await expect
    .poll(async () => await (await worker.fetch('http://probe.test/fills')).text(), {
      timeout: 5_000,
    })
    .toBe('1');
  // The next read finds the stored bundle at once, without a fill of its own.
  const next = await fill();
  expect(next).toMatchObject({
    status: 'ok',
    secrets: { AUDIT_RELAY_AXIOM_TOKEN: { value: 'axiom-token', version: 3 } },
    fillsBuilt: 1,
  });
  expect(next.ms).toBeLessThan(SLOW_FILL_MS);
}, 30_000);

// In each race the first racer's call never answers (the fixture's slow dependencies hang on
// their first call), so `completed` counting only the second racer's call shows the second racer
// was served by a call of its own, never by the first racer's.

it('serves the key set to a request that arrives while a cancelled request was fetching it', async () => {
  const result = await race('jwks');
  expect(result).toMatchObject({
    first: 'cancelled',
    second: 200,
    calls: { started: 2, completed: 1 },
  });
  expect(result.secondMs).toBeLessThan(PROMPT_MS);
  expect(JSON.parse(result.body)).toMatchObject({ keys: [{ kty: 'EC', alg: 'ES256' }] });
  expect(workerdLogs.filter(message => CROSS_REQUEST_WARNING.test(message))).toEqual([]);
}, 30_000);

it('checks a webhook that arrives while a cancelled request was loading the secret', async () => {
  const result = await race('webhook');
  // Signed with no known secret, so the gate refuses it once it has the secret.
  expect(result).toMatchObject({
    first: 'cancelled',
    second: 401,
    calls: { started: 2, completed: 1 },
  });
  expect(result.secondMs).toBeLessThan(PROMPT_MS);
  expect(workerdLogs.filter(message => CROSS_REQUEST_WARNING.test(message))).toEqual([]);
}, 30_000);

it('verifies a workload token that arrives while a cancelled request was discovering its provider', async () => {
  const result = await race('identity');
  // The first racer's discovery never answers; the second racer's discovery and key set fetch do.
  expect(result).toMatchObject({
    first: 'cancelled',
    second: 200,
    calls: { started: 3, completed: 2 },
  });
  // Discovery and the key set fetch take 500 ms each.
  expect(result.secondMs).toBeLessThan(PROMPT_MS + 500);
  expect(JSON.parse(result.body)).toEqual({
    status: 'verified',
    workload: 'fly-app',
    provider: 'fly',
  });
  expect(workerdLogs.filter(message => CROSS_REQUEST_WARNING.test(message))).toEqual([]);
}, 30_000);
