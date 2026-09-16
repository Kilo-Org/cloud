import { Effect, Stream } from 'effect';
import { afterAll, expect, it } from 'vitest';
import { ModelClient } from '../../core/model.js';
import { fakeFetch, type Reply, sampleRequest, sse } from './fake.js';
import { testGateway } from './test-gateway.js';

/**
 * What one streamed event costs the gateway, in CPU rather than in wall clock.
 *
 * Wall clock on this path measures Effect's stream runtime and not this
 * package: the work itself — read a frame, parse it, ask the wire three
 * questions — is 0.32 us of the 7.6 the whole gateway takes, measured
 * 2026-09-04. Nothing worth doing lives in that gap, and a ceiling on it would
 * only ever fail because a dependency changed.
 *
 * So the guards here are the two things a caller actually feels: how much CPU a
 * long answer burns, and whether the cost of one event grows with the length of
 * the answer. Both catch a rewrite that changes the shape of the work, which is
 * what a ceiling is for.
 */

/** Sequential, because concurrent streams would skew the time being measured. */
const repeat = async (times: number, run: () => Promise<unknown>): Promise<void> => {
  if (times <= 0) {
    return;
  }
  await run();
  await repeat(times - 1, run);
};

/** What one run measured, so a reader sees the number and not only the ceiling. */
const measured: string[] = [];

afterAll(() => {
  for (const line of measured) {
    process.stdout.write(`${line}\n`);
  }
});

const drained = (chunks: readonly string[]) => {
  const answer: Reply = { ok: true, status: 200, body: '', chunks };
  const { fetch } = fakeFetch([answer]);
  return Effect.runPromise(
    Effect.provide(
      Effect.flatMap(ModelClient, client => Stream.runDrain(client.stream(sampleRequest()))),
      testGateway({ fetch })
    )
  );
};

/** CPU actually burned per event, user and system, in microseconds. */
const busyPer = async (chunks: readonly string[], events: number, rounds: number) => {
  await drained(chunks);
  const started = process.cpuUsage();
  await repeat(rounds, () => drained(chunks));
  const spent = process.cpuUsage(started);
  return (spent.user + spent.system) / (rounds * events);
};

const deltas = (events: number): readonly string[] =>
  sse(
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    ...Array.from({ length: events }, () => ({
      type: 'content_block_delta',
      delta: { text: 'word ' },
    })),
    { type: 'message_delta', usage: { output_tokens: events } }
  );

it('burns under 70 us of CPU per streamed event', async () => {
  const busy = await busyPer(deltas(2000), 2000, 10);
  measured.push(`gateway: ${busy.toFixed(2)} us of CPU per event`);

  /* Measured at 14.4 us on 2026-09-04, which is high for this path because a
     single 2000 event run pays for its own warm-up: the same work over 5000
     events costs 5.0. Five times the higher number, like every other ceiling
     here — it catches an order of magnitude and not a busy machine. */
  expect(busy).toBeLessThan(70);
});

it('costs no more per event on a long answer than on a short one', async () => {
  const short = await busyPer(deltas(200), 200, 30);
  const long = await busyPer(deltas(5000), 5000, 4);
  measured.push(`gateway: ${short.toFixed(2)} us of CPU at 200 events, ${long.toFixed(2)} at 5000`);

  /* The answer is read a frame at a time and nothing holds the whole of it, so
     the long one is cheaper: the fixed cost of the call is spread further. A
     rewrite that copied what it had so far would invert this. */
  expect(long).toBeLessThan(short);
});

/**
 * A tool call arrives in fragments and the gateway holds the open one between
 * events. It grows the arguments in place; a fold that rebuilt them on every
 * fragment would be quadratic, and only a long argument list would show it.
 */
const fragments = (count: number): readonly string[] =>
  sse(
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'tc_1', name: 'weather' },
    },
    ...Array.from({ length: count }, () => ({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '00000000' },
    })),
    { type: 'content_block_stop' },
    { type: 'message_delta', usage: { output_tokens: count } }
  );

it('costs no more per fragment on a long tool call than on a short one', async () => {
  const short = await busyPer(fragments(200), 200, 30);
  const long = await busyPer(fragments(4000), 4000, 4);
  measured.push(
    `gateway: ${short.toFixed(2)} us of CPU per fragment at 200, ${long.toFixed(2)} at 4000`
  );

  /* Linear holds the two close, and the long one is cheaper for the same reason
     as above. Quadratic makes it many times the short one, so four times
     separates the shapes without failing on noise. */
  expect(long).toBeLessThan(short * 4);
});
