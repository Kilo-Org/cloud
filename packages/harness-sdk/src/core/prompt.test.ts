import { Chunk, Effect } from 'effect';
import { expect, it } from 'vitest';
import { assemble } from '../plugins/prompt/default.js';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { makeTurn } from './turn.js';
import { textIn } from './prompt.js';

const entropy = seededEntropy(1);

const system = 'You are a harness.';

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

const turns = (...contents: readonly string[]) =>
  Chunk.fromIterable(
    run(
      Effect.all(
        contents.map(content =>
          makeTurn(entropy, {
            sessionId: 'ses_1',
            role: 'user',
            parts: [{ kind: 'text', body: content }],
          })
        )
      )
    )
  );

it('breaks the cache after the system prompt and on the last turn', () => {
  const prompt = assemble({ system, turns: turns('a', 'b') });
  expect(prompt.system).toEqual([{ text: system, cache: true }]);
  expect(prompt.messages.map(message => message.cache)).toEqual([false, true]);
});

it('gives the same bytes for the same input', () => {
  const input = { system, turns: turns('a', 'b') };
  expect(JSON.stringify(assemble(input))).toBe(JSON.stringify(assemble(input)));
});

it('leaves every earlier message unchanged when a turn is appended', () => {
  const before = turns('a', 'b');
  const [added] = run(
    Effect.all([
      makeTurn(entropy, {
        sessionId: 'ses_1',
        role: 'assistant',
        parts: [{ kind: 'text', body: 'c' }],
      }),
    ])
  );
  const after = Chunk.append(before, added);

  const grown = assemble({ system, turns: after });
  expect(grown.messages.slice(0, Chunk.size(before)).map(textIn)).toEqual(
    assemble({ system, turns: before }).messages.map(textIn)
  );
  expect(grown.system).toEqual(assemble({ system, turns: before }).system);
});

it('still breaks the cache after the system prompt when the session has no turns', () => {
  const prompt = assemble({ system, turns: Chunk.empty() });
  expect(prompt.system).toEqual([{ text: system, cache: true }]);
});
