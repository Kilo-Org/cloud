import { Clock, Effect, Option } from 'effect';
import type { Prompt, PromptAssemblerService } from './prompt.js';
import type { SessionStoreService, StoredSession } from './storage.js';
import type { Turn } from './turn.js';

/**
 * What a plugin has to get right, run against the plugin.
 *
 * A plugin point is two functions and a type, so writing one is easy and
 * getting one wrong is easier: a store that reorders turns, drops a signature,
 * or loses a column typechecks, answers every call, and breaks the model cache
 * one reload later. An assembler that rewrites an earlier message typechecks
 * too, and costs the whole prefix on every question from then on.
 *
 * Neither of those shows up as an error. They show up as a bill. So the package
 * ships the checks rather than describing them: run one against your plugin in
 * whatever test runner you already have, and assert the answer is empty.
 *
 * ```ts
 * const wrong = await Effect.runPromise(checkStore(myStore));
 * expect(wrong).toEqual([]);
 * ```
 *
 * Each answers a list of what it found, in the words the author needs. Empty
 * means it conforms. Neither fails: a store that refuses a write is a finding.
 */

/** What a plugin got wrong. Empty means it conforms. */
type Broken = readonly string[];

const wrongIf = (broken: boolean, wrong: string): Broken => (broken ? [wrong] : []);

/**
 * Equal but for the order of an object's keys, and for a field that is absent
 * rather than undefined.
 *
 * A store rebuilds what it gives back, so one that is right in every way that
 * matters may still name its fields in another order or leave an optional one
 * off. Comparing the JSON would call both a defect.
 */
const named = (held: object) => Object.entries(held).filter(([, value]) => value !== undefined);

const same = (one: unknown, other: unknown): boolean => {
  if (one === other) {
    return true;
  }
  if (!(one instanceof Object) || !(other instanceof Object)) {
    return false;
  }
  if (Array.isArray(one) || Array.isArray(other)) {
    return (
      Array.isArray(one) &&
      Array.isArray(other) &&
      one.length === other.length &&
      one.every((item, at) => same(item, other[at]))
    );
  }
  const left = named(one);
  return (
    left.length === named(other).length &&
    left.every(([key, value]) => same(value, Reflect.get(other, key)))
  );
};

/**
 * Every part kind in one turn, so a store that drops a column is caught by the
 * check rather than by a session that will not replay a year from now.
 *
 * The identifiers here sort in the order the turns and parts were made, because
 * a real one does: `makeId` builds a ULID, and a store is allowed to read them
 * back in that order rather than keeping a column for it.
 */
const answerFor = (sessionId: string): Turn => ({
  id: 'trn_2',
  sessionId,
  role: 'assistant',
  parts: [
    { id: 'prt_2_1', kind: 'reasoning', body: 'thought about it', signature: 'sig_abc' },
    { id: 'prt_2_2', kind: 'redacted', body: 'ENCRYPTED' },
    { id: 'prt_2_3', kind: 'toolCall', body: '{"city":"Oslo"}', callId: 'tc_1', name: 'weather' },
    { id: 'prt_2_4', kind: 'toolResult', body: 'it rains', callId: 'tc_1', failed: false },
    { id: 'prt_2_5', kind: 'text', body: 'it rains in Oslo' },
  ],
});

const questionFor = (sessionId: string): Turn => ({
  id: 'trn_1',
  sessionId,
  role: 'user',
  parts: [
    { id: 'prt_1_1', kind: 'text', body: 'what is the weather' },
    { id: 'prt_1_2', kind: 'image', body: 'aGk=', media: 'image/png' },
  ],
});

const laterFor = (sessionId: string): Turn => ({
  id: 'trn_3',
  sessionId,
  role: 'user',
  parts: [{ id: 'prt_3_1', kind: 'text', body: 'and tomorrow' }],
});

const sessionFor = (id: string): StoredSession => ({
  id,
  system: 'You are terse.',
  model: 'anthropic/claude-haiku-4.5',
  effort: 'medium',
  maxTokens: 512,
  tools: ['weather', 'question'],
});

/** Runs one store call and reports a refusal rather than raising it. */
const tried = <A>(
  work: Effect.Effect<A, unknown>,
  what: string
): Effect.Effect<{ readonly got: Option.Option<A>; readonly wrong: Broken }> =>
  Effect.match(work, {
    onFailure: (cause: unknown) => ({
      got: Option.none<A>(),
      wrong: [`${what} refused the call: ${String(cause)}`],
    }),
    onSuccess: (got: A) => ({ got: Option.some(got), wrong: [] }),
  });

/** A session that was never written must read as nothing, not as an empty one. */
const checkUnknown = (store: SessionStoreService, id: string): Effect.Effect<Broken> =>
  Effect.map(
    Effect.all({
      read: tried(store.read(`${id}_never`), 'read'),
      load: tried(store.load(`${id}_never`), 'load'),
    }),
    ({ read, load }) => [
      ...read.wrong,
      ...load.wrong,
      ...wrongIf(
        Option.getOrUndefined(read.got)?._tag === 'Some',
        'read answered Some for a session that was never created. It must answer None.'
      ),
      ...wrongIf(
        (Option.getOrUndefined(load.got) ?? []).length > 0,
        'load answered turns for a session that was never created. It must answer none.'
      ),
    ]
  );

/** What was written comes back as it was written, field for field. */
const checkSession = (store: SessionStoreService, id: string): Effect.Effect<Broken> =>
  Effect.gen(function* () {
    const written = sessionFor(id);
    const created = yield* tried(store.create(written), 'create');
    const read = yield* tried(store.read(id), 'read');
    const got = Option.flatten(read.got);
    return [
      ...created.wrong,
      ...read.wrong,
      ...wrongIf(Option.isNone(got), 'read answered None for a session create was given.'),
      ...wrongIf(
        Option.isSome(got) && !same({ ...got.value, prompted: undefined }, written),
        'read gave back a session that is not the one create was given. Every field ' +
          'is reopened from the store, so one that is dropped reopens the session ' +
          `differently. Written ${JSON.stringify(written)}, read back ` +
          `${JSON.stringify(Option.getOrUndefined(got))}.`
      ),
    ];
  });

/** Turns come back in the order they were written, byte for byte. */
const checkTurns = (store: SessionStoreService, id: string): Effect.Effect<Broken> =>
  Effect.gen(function* () {
    const first: readonly Turn[] = [questionFor(id), answerFor(id)];
    const second: readonly Turn[] = [laterFor(id)];
    const one = yield* tried(store.append({ sessionId: id, turns: first, prompted: 11 }), 'append');
    const two = yield* tried(store.append({ sessionId: id, turns: second, prompted: 22 }), 'append');
    const flushed = yield* tried(store.flush(), 'flush');
    const loaded = yield* tried(store.load(id), 'load');
    const got = Option.getOrElse(loaded.got, (): readonly Turn[] => []);
    return [
      ...one.wrong,
      ...two.wrong,
      ...flushed.wrong,
      ...loaded.wrong,
      ...wrongIf(
        !same(got, [...first, ...second]),
        'load gave back turns that are not the ones append was given, in the order it ' +
          'was given them. A turn that comes back changed, reordered, or short of a ' +
          'part rebuilds the prompt prefix differently and misses the model cache on ' +
          `every request from then on. Written ${JSON.stringify([...first, ...second])}, ` +
          `read back ${JSON.stringify(got)}.`
      ),
    ];
  });

/** The count the last append carried is what a reopened session starts from. */
const checkPrompted = (store: SessionStoreService, id: string): Effect.Effect<Broken> =>
  Effect.map(tried(store.read(id), 'read'), read => {
    const got = Option.getOrUndefined(Option.flatten(read.got))?.prompted;
    return [
      ...read.wrong,
      ...wrongIf(
        got !== 22,
        'read gave back a prompted count of ' +
          `${String(got)} after two appends of 11 and 22. It must be the last one: ` +
          'it is what decides whether a reopened session compacts before its next ' +
          'question, and a stale one compacts too early or not at all.'
      ),
    ];
  });

/** One session's turns must not reach another's. */
const checkApart = (store: SessionStoreService, id: string): Effect.Effect<Broken> =>
  Effect.gen(function* () {
    const other = `${id}_other`;
    yield* tried(store.create(sessionFor(other)), 'create');
    yield* tried(store.append({ sessionId: other, turns: [laterFor(other)], prompted: 1 }), 'append');
    const loaded = yield* tried(store.load(id), 'load');
    const got = Option.getOrElse(loaded.got, (): readonly Turn[] => []);
    return [
      ...loaded.wrong,
      ...wrongIf(
        got.some(turn => turn.sessionId !== id),
        'load gave back a turn belonging to another session. Every read is by ' +
          'session, and a store that answers across them puts one conversation into ' +
          "another's prompt."
      ),
    ];
  });

/**
 * Checks a `SessionStore` plugin against everything a session needs from one.
 *
 * It writes two sessions under identifiers of its own, so it is safe to run
 * against a real store; nothing else is touched, and nothing is deleted, which
 * a store has no method for. Run it against a fresh store for the clearest
 * answer.
 */
const checkStore = (store: SessionStoreService): Effect.Effect<Broken> =>
  Effect.gen(function* () {
    const id = `ses_check_${String(yield* Clock.currentTimeMillis)}`;
    const unknown = yield* checkUnknown(store, id);
    const session = yield* checkSession(store, id);
    const turns = yield* checkTurns(store, id);
    const prompted = yield* checkPrompted(store, id);
    const apart = yield* checkApart(store, id);
    return [...unknown, ...session, ...turns, ...prompted, ...apart];
  });

const builtBy = (assembler: PromptAssemblerService, turns: readonly Turn[]) =>
  assembler.assemble({ system: 'You are terse.', turns });

/**
 * What each message says, without its breakpoint.
 *
 * The breakpoint is a marker and not content: an assembler marks the last
 * message so the next request reads everything before it, so the mark moves
 * with every turn while nothing that was sent changes. Holding it against an
 * assembler would fail the one this package ships.
 */
const said = (prompt: Prompt) =>
  prompt.messages.map(({ cache: _cache, ...rest }) => rest);

/**
 * Checks a `PromptAssembler` plugin against the two invariants that decide
 * whether the model cache is won or lost.
 *
 * Both are silent when broken. The same input giving different bytes, or an
 * appended turn changing what came before it, moves the prefix: every request
 * from then on writes the cache instead of reading it, and the only symptom is
 * the bill.
 */
const checkAssembler = (assembler: PromptAssemblerService): Broken => {
  const id = 'ses_check';
  const asked: readonly Turn[] = [questionFor(id), answerFor(id)];
  const before = builtBy(assembler, asked);
  const after = builtBy(assembler, [...asked, laterFor(id)]);
  return [
    ...wrongIf(
      JSON.stringify(before) !== JSON.stringify(builtBy(assembler, asked)),
      'assemble gave different bytes for the same input. Something in it varies: a ' +
        'clock, a random value, or a key order. Every question would miss the cache.'
    ),
    ...wrongIf(
      JSON.stringify(after.system) !== JSON.stringify(before.system),
      'assemble changed the system prompt when a turn was appended. It is the front ' +
        'of the cached prefix, so a change there costs the whole conversation on ' +
        'every question from then on.'
    ),
    ...wrongIf(
      JSON.stringify(said(after).slice(0, before.messages.length)) !==
        JSON.stringify(said(before)),
      'assemble rewrote what came before an appended turn. Everything up to the new ' +
        'turn must be byte for byte what it was, or the prefix moves and the whole ' +
        'conversation is written to the cache again on every question.'
    ),
  ];
};

export type { Broken };
export { checkAssembler, checkStore };
