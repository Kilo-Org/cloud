/**
 * Proves an image reaches the model, in every shape, and survives the replay.
 *
 * The three shapes render an image three different ways, and until this run
 * each had only ever been checked against a fake `fetch`. Every shape is given
 * a different colour, so a model that never saw the picture would have to guess
 * three specific words to pass.
 *
 * The second question is the one that matters. It asks about the background,
 * which the first answer never mentioned, so it can only be answered from the
 * picture itself. An assembler that dropped the image from the second request
 * would leave the model with its own earlier word and nothing else.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { ApiKind } from '../src/core/catalog.js';
import { said } from '../src/core/model.js';
import { openSession } from '../src/core/run.js';
import type { PartDraft } from '../src/core/turn.js';
import type { SessionHandle } from '../src/core/handle.js';
import { kilo, models } from './setup.js';
import { fail, passed, under } from './report.js';

const system =
  'You look at pictures and answer about them. ' +
  'Answer with one lowercase word and nothing else. ' +
  'Do not explain. Do not add punctuation. Never say you cannot see an image.';

/** A different colour per shape, so one lucky guess cannot pass the run. */
const shapes: readonly { readonly kind: ApiKind; readonly colour: string }[] = [
  { kind: 'messages', colour: 'green' },
  { kind: 'responses', colour: 'blue' },
  { kind: 'chat_completions', colour: 'yellow' },
];

/** A caller holds a file, not base64. This is the line every caller writes. */
const pictureOf = async (colour: string): Promise<PartDraft> => ({
  kind: 'image',
  media: 'image/png',
  body: (await readFile(join(import.meta.dirname, 'images', `${colour}-circle.png`))).toString(
    'base64'
  ),
});

const say = (session: SessionHandle, input: string | readonly PartDraft[]) =>
  said(session.ask(input));

const runShape = async (model: string, kind: ApiKind, colour: string) => {
  const layers = kilo({ apiKinds: [kind] });

  const picture = await pictureOf(colour);

  const program = Effect.gen(function* () {
    /* Room to spare. A reasoning model spends its thinking out of this, and a
       tight ceiling starved the second answer to nothing on two shapes. The
       ceiling is what `stop.ts` tests; this run tests the picture. */
    const session = yield* openSession({ system, model, maxTokens: 256 });
    const named = yield* say(session, [
      { kind: 'text', body: 'What colour is the circle in this picture?' },
      picture,
    ]);
    /* Nothing said so far names the background, so this needs the picture. */
    const background = yield* say(
      session,
      'Is the background of that picture white or black? Answer white or black.'
    );
    return { named, background };
  });

  return Effect.runPromise(Effect.either(Effect.scoped(Effect.provide(program, layers))));
};

const word = (said: string) => said.toLowerCase().replaceAll(/[^a-z]/gu, '');

for (const model of models) {
  under(model);

  console.log('model', model);
  console.log('\nshape             sent      named     background');

  for (const { kind, colour } of shapes) {
    const result = await runShape(model, kind, colour);
    if (result._tag === 'Left') {
      console.log(`${kind.padEnd(18)}${colour.padEnd(10)}FAILED    ${JSON.stringify(result.left)}`);
      fail(`${kind}: the call failed`);
      continue;
    }

    const named = word(result.right.named);
    const background = word(result.right.background);
    console.log(`${kind.padEnd(18)}${colour.padEnd(10)}${named.padEnd(10)}${background}`);

    if (named !== colour) {
      fail(`${kind}: the picture was ${colour} and the model said ${JSON.stringify(named)}`);
    }
    if (background !== 'white') {
      fail(
        `${kind}: the background is white and the model said ${JSON.stringify(background)}, ` +
          'so the picture did not survive into the second request'
      );
    }
  }
}

passed('every shape carried the picture, and every shape replayed it.');
