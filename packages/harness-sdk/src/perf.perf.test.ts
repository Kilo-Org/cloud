import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { layerTableCatalog } from './plugins/catalog/table.js';
import { messagesWire } from './plugins/gateway/wire/messages.js';
import { seededEntropy, layerSeededEntropy } from './plugins/entropy/seeded.js';
import { fakeFetch, type Reply } from './plugins/gateway/fake.js';
import { testGateway } from './plugins/gateway/test-gateway.js';
import { assemble, layerAssembler } from './plugins/prompt/default.js';
import { makeId } from './core/id.js';
import { openSession } from './core/run.js';
import { appendTurn, makeSession } from './core/session.js';
import { makeTurn } from './core/turn.js';

/**
 * These guard against a regression in order of magnitude, not against noise.
 * Every ceiling is roughly five times the number measured on 2026-09-03 (see
 * the Performance section of AGENTS.md), so a change that doubles a cost still
 * passes and a change that breaks the shape of the work does not.
 *
 * A timing test that fails on a busy laptop is worse than no timing test, so
 * each figure is the median of several runs and the ceilings are generous.
 */
const spin = (reps: number, run: () => void): void => {
  for (let index = 0; index < reps; index += 1) {
    run();
  }
};

const medianMicros = (reps: number, run: () => void): number => {
  spin(reps, run);
  const taken: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const started = performance.now();
    spin(reps, run);
    taken.push(((performance.now() - started) * 1000) / reps);
  }
  return taken.toSorted((a, b) => a - b)[2] ?? 0;
};

const entropy = seededEntropy(11);

const sessionOf = (turns: number) => {
  let held = Effect.runSync(makeSession(entropy));
  for (let index = 0; index < turns; index += 1) {
    held = appendTurn(
      held,
      Effect.runSync(
        makeTurn(entropy, {
          sessionId: held.id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [
            {
              kind: 'text',
              body: `message number ${String(index)} with enough text to weigh something`,
            },
          ],
        })
      )
    );
  }
  return held;
};

it('assembles a 200 turn prompt in well under 20 us', () => {
  const { turns } = sessionOf(200);
  const cost = medianMicros(2000, () => void assemble({ system: 'sys', turns }));
  expect(cost).toBeLessThan(20);
});

it('assembles in time linear in the turn count, not quadratic', () => {
  const small = sessionOf(100).turns;
  const large = sessionOf(800).turns;
  const smallCost = medianMicros(2000, () => void assemble({ system: 'sys', turns: small }));
  const largeCost = medianMicros(500, () => void assemble({ system: 'sys', turns: large }));

  /* Eight times the turns. Linear lands near 8x; quadratic lands near 64x.
     Twenty catches the shape change without failing on a noisy machine. */
  expect(largeCost / smallCost).toBeLessThan(20);
});

it('builds a whole 200 turn request in well under 250 us', () => {
  const { turns } = sessionOf(200);
  const system = Array.from({ length: 200 }, (_, index) => `Rule ${String(index)}: be terse.`).join(
    '\n'
  );

  /* Everything one question costs before the socket: the prompt, the body of
     the shape, and the JSON. Measured at 48 us — 17 to assemble, 6 for the
     body, 32 for `JSON.stringify` of 27 kilobytes. The provider's own first
     token took between 849 and 4064 ms on the ten model matrix, so this whole
     path is a ten-thousandth of the wait and is not worth optimising. The
     ceiling is here to catch a rewrite that makes it matter. */
  const cost = medianMicros(
    500,
    () =>
      void JSON.stringify(
        messagesWire.toBody({
          prompt: assemble({ system, turns }),
          model: 'm',
          maxTokens: 1024,
          stream: true,
          cacheKey: 'ses_1',
        })
      )
  );
  expect(cost).toBeLessThan(250);
});

it('makes an identifier in under 5 us', () => {
  const cost = medianMicros(20_000, () => void Effect.runSync(makeId(entropy, 'trn')));
  expect(cost).toBeLessThan(5);
});

it('draws randomness once per millisecond, not once per identifier', () => {
  const drawn = { count: 0 };
  const counting = {
    bytes: (size: number) => {
      drawn.count += 1;
      return entropy.bytes(size);
    },
  };
  const started = Date.now();
  for (let index = 0; index < 50_000; index += 1) {
    Effect.runSync(makeId(counting, 'trn'));
  }
  const spanned = Date.now() - started + 1;

  /* The monotonic counter refills only when the clock moves, so the cost of
     entropy is bounded by wall time: 44 draws for 50000 identifiers when this
     was written. A refill per identifier would be 50000, so any bound near the
     elapsed milliseconds separates the two by three orders of magnitude. */
  expect(drawn.count).toBeLessThan(spanned * 2 + 20);
});

/** Sequential, because concurrent rounds would skew the time being measured. */
const repeat = async (times: number, run: () => Promise<void>): Promise<void> => {
  if (times <= 0) {
    return;
  }
  await run();
  await repeat(times - 1, run);
};

const sse = (...events: readonly unknown[]): readonly string[] =>
  events.map(event => `data: ${JSON.stringify(event)}\n\n`);

it('streams a token for under 60 us end to end', async () => {
  const tokens = 200;
  const chunks = sse(
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    ...Array.from({ length: tokens }, () => ({
      type: 'content_block_delta',
      delta: { text: 'word ' },
    })),
    { type: 'message_delta', usage: { output_tokens: tokens } }
  );
  const answer: Reply = { ok: true, status: 200, body: '', chunks };

  const once = async () => {
    const { fetch } = fakeFetch([answer]);
    await Effect.runPromise(
      Effect.provide(
        Effect.scoped(
          Effect.flatMap(openSession({ system: 'sys', model: 'm', maxTokens: 64 }), session =>
            Stream.runDrain(session.ask('hi'))
          )
        ),
        Layer.mergeAll(
          layerAssembler,
          layerTableCatalog({}, { apiKinds: ['messages'] }),
          layerSeededEntropy(5),
          testGateway({ fetch })
        )
      )
    );
  };

  await once();
  const rounds = 20;
  const started = performance.now();
  await repeat(rounds, once);
  const perToken = ((performance.now() - started) * 1000) / (rounds * tokens);

  /* Measured at 17.8 us per token through the whole session, which is more
     than the 7 us of the gateway path alone because this counts the session,
     the store hook and the turn recording too. The ceiling catches a rewrite
     that adds an order of magnitude, which an accidental await or copy would. */
  expect(perToken).toBeLessThan(90);
});

it('holds a 2000 turn session in memory linear in the turn count', () => {
  const before = sessionOf(1000);
  const after = sessionOf(2000);

  /* An append copies the array of turns, so the cost of growing a session is
     quadratic in principle. What the number below says is that it does not
     matter at any length a context window allows: a hundred appends cost less
     than one round trip's first byte by four orders of magnitude. */
  expect(before.turns).toHaveLength(1000);
  expect(after.turns).toHaveLength(2000);

  const hundred = before.turns.slice(0, 100);
  const growth = medianMicros(200, () => {
    let held = sessionOf(0);
    for (const turn of hundred) {
      held = appendTurn(held, turn);
    }
  });
  expect(growth).toBeLessThan(500);
});
