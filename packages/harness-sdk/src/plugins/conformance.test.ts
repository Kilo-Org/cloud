import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { layerAssembler } from './prompt/default.js';
import { layerNodeStore } from './store/node.js';
import { checkAssembler, checkStore } from '../core/conformance.js';
import {
  PromptAssembler,
  type PromptAssemblerService,
  type PromptMessage,
} from '../core/prompt.js';
import { SessionStore, type SessionStoreService, StoreError } from '../core/storage.js';
import type { Turn } from '../core/turn.js';

/** A turn a broken store can hand back for a session that has none. */
const laterTurn: Turn = {
  id: 'trn_x',
  sessionId: 'ses_x',
  role: 'user',
  parts: [{ id: 'prt_x', kind: 'text', body: 'not yours' }],
};

/**
 * The checks a plugin author runs, run against the plugins this package ships
 * and against plugins broken on purpose.
 *
 * Both halves matter. A check that passes the package's own plugins and nothing
 * else is a check that says yes to everything, and an author would trust it to
 * the day their store silently reordered a turn.
 */

/** The shipped store, on a database that lives as long as the one check. */
const nodeStore = <A>(use: (store: SessionStoreService) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.flatMap(SessionStore, use),
        layerNodeStore(new DatabaseSync(':memory:'))
      )
    )
  );

const assembler = Effect.runSync(Effect.provide(PromptAssembler, layerAssembler));

it('passes the store this package ships', async () => {
  const wrong = await nodeStore(checkStore);

  expect(wrong).toEqual([]);
});

it('passes the assembler this package ships', () => {
  expect(checkAssembler(assembler)).toEqual([]);
});

it('catches a store that hands the turns back in the wrong order', async () => {
  const wrong = await nodeStore(store =>
    checkStore({ ...store, load: id => Effect.map(store.load(id), turns => turns.toReversed()) })
  );

  expect(wrong.join('\n')).toContain('in the order it was given them');
});

/** Gives every signature back changed, which is the same as losing it. */
const bend = (turn: Turn): Turn => ({
  ...turn,
  parts: turn.parts.map(part =>
    part.kind === 'reasoning' ? { ...part, signature: 'sig_other' } : part
  ),
});

it('catches a store that gives a signature back changed', async () => {
  const wrong = await nodeStore(store =>
    checkStore({ ...store, load: id => Effect.map(store.load(id), turns => turns.map(bend)) })
  );

  /* A signature that comes back changed cannot be replayed, and nothing but a
     check like this notices until the provider refuses a request. */
  expect(wrong.join('\n')).toContain('not the ones append was given');
});

it('catches a store that answers for a session it never heard of', async () => {
  const wrong = await nodeStore(store =>
    checkStore({
      ...store,
      load: (id: string) => Effect.succeed([{ ...laterTurn, sessionId: id }]),
    })
  );

  expect(wrong.join('\n')).toContain('never created');
});

it('catches a store that keeps the first prompted count rather than the last', async () => {
  const wrong = await nodeStore(store =>
    checkStore({ ...store, append: exchange => store.append({ ...exchange, prompted: 11 }) })
  );

  expect(wrong.join('\n')).toContain('prompted count');
});

it('catches a store that refuses a write', async () => {
  const wrong = await nodeStore(store =>
    checkStore({
      ...store,
      append: () => Effect.fail(new StoreError({ operation: 'append', cause: 'the disk is full' })),
    })
  );

  expect(wrong.join('\n')).toContain('append refused the call');
});

it('catches an assembler that does not give the same bytes twice', () => {
  let count = 0;
  const drifting: PromptAssemblerService = {
    assemble: input => {
      count += 1;
      const built = assembler.assemble(input);
      return { ...built, system: [{ text: String(count), cache: true }, ...built.system] };
    },
  };

  expect(checkAssembler(drifting).join('\n')).toContain('different bytes for the same input');
});

it('catches an assembler that rewrites what came before an appended turn', () => {
  const rewriting: PromptAssemblerService = {
    assemble: input => {
      const built = assembler.assemble(input);
      /* Numbers each message out of how many there are, which is the shape of
         every accidental rewrite: harmless-looking, and it moves every byte
         after the first message the moment a turn is added. */
      const numbered = (message: PromptMessage, at: number): PromptMessage => ({
        role: message.role,
        cache: message.cache,
        parts: [
          { kind: 'text', text: `${String(at)}/${String(built.messages.length)} ` },
          ...message.parts,
        ],
      });
      return { ...built, messages: built.messages.map(numbered) };
    },
  };

  expect(checkAssembler(rewriting).join('\n')).toContain('rewrote what came before');
});
