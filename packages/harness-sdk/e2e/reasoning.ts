/**
 * Proves the model's thinking goes back to the provider and is accepted.
 *
 * The unit tests prove the block survives the round trip through this package.
 * They cannot prove the provider agrees, and the provider is the only judge:
 * it seals the thinking and refuses a seal it cannot read.
 *
 * Each shape seals it differently, so each is run on its own:
 *
 * - `messages` signs a thinking block, and the signature travels with it.
 * - `responses` hands back a reasoning item holding its own encrypted copy,
 *   which the request has to ask for with `include`.
 * - `chat_completions` has no replay at all, so it is only checked for still
 *   carrying the conversation.
 *
 * Two questions in one session. The second request carries the first answer's
 * thinking. If the seal were wrong — dropped, edited, put in the wrong place —
 * the second call would fail, not answer differently.
 */
import { Effect, Stream } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import { openSession } from '../src/core/run.js';
import type { Turn } from '../src/core/turn.js';
import type { SessionHandle } from '../src/core/handle.js';
import { kilo } from './setup.js';
import { fail, passed } from './report.js';

const system = 'You answer briefly. Think first, then give the answer in one short sentence.';

/** Two questions worth thinking about, where the second follows on from the first. */
const first = 'A farmer has 17 sheep. All but 9 run away. How many are left? Explain in one line.';
const second = 'Now double that number and tell me the result.';

/**
 * A model that thinks, per shape. One that does not would pass this run
 * vacuously, which is why the run fails when no thinking arrives.
 */
const shapes: readonly {
  readonly kind: ApiKind;
  readonly model: string;
  /** Whether this shape hands back something that lets the thinking be replayed. */
  readonly seals: boolean;
}[] = [
  { kind: 'messages', model: 'anthropic/claude-sonnet-4.5', seals: true },
  { kind: 'responses', model: 'anthropic/claude-sonnet-4.5', seals: true },
  /* The thinking arrives here too, but with nothing to prove it is the
     model's own, so it is kept for the reader and never replayed. */
  { kind: 'chat_completions', model: 'anthropic/claude-sonnet-4.5', seals: false },
];

interface Answer {
  readonly said: string;
  readonly thought: string;
  /** What the request carried. A replayed block shows up here and nowhere else. */
  readonly input: number;
}

const empty: Answer = { said: '', thought: '', input: 0 };

const ask = (session: SessionHandle, text: string) =>
  Stream.runFold(session.ask(text, { maxTokens: 4000 }), empty, (held, event) => {
    switch (event.kind) {
      case 'delta': {
        return { ...held, said: held.said + event.text };
      }
      case 'reasoning': {
        return { ...held, thought: held.thought + event.text };
      }
      case 'done': {
        return { ...held, input: event.usage.inputTokens + event.usage.cacheReadTokens };
      }
      case 'redacted':
      case 'toolCall':
      case 'toolResult': {
        return held;
      }
    }
  });

const runShape = async (kind: ApiKind, model: string) => {
  const layers = kilo({ apiKinds: [kind] });

  const program = Effect.gen(function* () {
    const session = yield* openSession({ system, model, effort: 'medium' });
    const one = yield* ask(session, first);
    const two = yield* ask(session, second);
    return { one, two, history: yield* session.history };
  });

  return Effect.runPromise(Effect.either(Effect.scoped(Effect.provide(program, layers))));
};

const reasoningOf = (turn: Turn | undefined) =>
  turn?.parts.filter(part => part.kind === 'reasoning') ?? [];

console.log(
  'shape             model                        thought  seal   blocks input  answered'
);

for (const { kind, model, seals } of shapes) {
  const result = await runShape(kind, model);
  if (result._tag === 'Left') {
    console.log(`${kind.padEnd(18)}${model.padEnd(29)}FAILED ${JSON.stringify(result.left)}`);
    fail(`${kind}: the call failed`);
    continue;
  }

  const { one, two, history } = result.right;
  const stored = reasoningOf(history[1]);
  const seal = stored[0]?.signature;
  const thought = one.thought.length > 0 || seal !== undefined;

  console.log(
    `${kind.padEnd(18)}${model.padEnd(29)}${String(thought).padEnd(9)}` +
      `${(seal === undefined ? 'none' : String(seal.length)).padEnd(7)}` +
      `${String(stored.length).padEnd(7)}` +
      `${String(two.input).padEnd(7)}` +
      JSON.stringify(two.said.slice(0, 24))
  );

  if (seals && !thought) {
    fail(`${kind}: the model produced no thinking, so this shape proves nothing`);
  }
  /* One thinking block or several: the model decides, and a model that thinks
     again after answering part way produces two. What may never happen is a
     stored block without a seal — the wire drops it, so the thinking the
     provider signed would go back with a hole in it. */
  const unsealed = stored.filter(part => part.signature === undefined).length;
  if (seals && stored.length === 0) {
    fail(`${kind}: the answer kept no thinking at all, so nothing can be replayed`);
  }
  if (seals && unsealed > 0) {
    fail(
      `${kind}: ${String(unsealed)} of ${String(stored.length)} stored thinking blocks carry ` +
        'no seal, so the wire drops them and the thinking goes back with a hole in it'
    );
  }
  if (two.said.length === 0) {
    fail(`${kind}: the second call carried the thinking back and produced no answer`);
  }
}

passed('every shape took its own thinking back and answered on top of it.');
