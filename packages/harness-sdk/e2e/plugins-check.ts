/* Every code block in PLUGINS.md, with the package name resolved to this
   source tree. It is typechecked, never run: a plugin author copies these, so
   one that does not compile is worse than no example at all. */
import { Effect, Layer, Option, Schedule, Stream } from 'effect';
import { checkAssembler, checkStore } from '../src/core/conformance.js';
import { EntropySource } from '../src/core/entropy.js';
import { ModelCatalog } from '../src/core/catalog.js';
import { ModelClient, type ModelEvent, zeroUsage } from '../src/core/model.js';
import { PromptAssembler, type PromptPart } from '../src/core/prompt.js';
import { RetryPolicy } from '../src/core/retry.js';
import { SessionStore, type StoredSession } from '../src/core/storage.js';
import { TokenError, TokenSource } from '../src/core/token.js';
import { ToolRegistry, type Tool } from '../src/core/tool.js';
import type { Turn, TurnPart } from '../src/core/turn.js';

/* Wiring one in. */

export const layerEcho = Layer.succeed(ModelClient, {
  stream: request =>
    Stream.fromIterable<ModelEvent>([
      { kind: 'delta', text: `you said ${String(request.prompt.messages.length)} things` },
      { kind: 'done', usage: zeroUsage, stop: 'end' },
    ]),
});

/* A store that keeps everything in memory. */

export const layerMemory = Layer.sync(SessionStore, () => {
  const sessions = new Map<string, StoredSession>();
  const turns = new Map<string, readonly Turn[]>();
  return {
    create: session => Effect.sync(() => void sessions.set(session.id, session)),
    read: id => Effect.sync(() => Option.fromNullable(sessions.get(id))),
    append: ({ sessionId, turns: added, prompted }) =>
      Effect.sync(() => {
        turns.set(sessionId, [...(turns.get(sessionId) ?? []), ...added]);
        const held = sessions.get(sessionId);
        if (held !== undefined) {
          sessions.set(sessionId, { ...held, prompted });
        }
      }),
    load: id => Effect.sync(() => turns.get(id) ?? []),
    flush: () => Effect.void,
  };
});

/* An assembler, on a transcript of text only. */

const renderPart = (part: TurnPart): readonly PromptPart[] =>
  part.kind === 'text' ? [{ kind: 'text', text: part.body }] : [];

export const layerPlain = Layer.succeed(PromptAssembler, {
  assemble: ({ system, turns }) => ({
    system: [{ text: system, cache: true }],
    messages: turns.map((turn, at) => ({
      role: turn.role,
      parts: turn.parts.flatMap(renderPart),
      cache: at === turns.length - 1,
    })),
  }),
});

/* A catalog that answers for every model. */

export const layerEverything = Layer.succeed(ModelCatalog, {
  facts: () => Effect.succeed({ apiKinds: ['messages'], contextWindow: 200_000 }),
});

/* A registry. */

declare const weather: Tool;

export const layerTools = Layer.succeed(ToolRegistry, { tools: [weather] });

/* A credential that expires, read inside the effect. */

declare const mint: () => Promise<{ readonly value: string; readonly until: number }>;
let held: { readonly value: string; readonly until: number } | undefined;

export const refreshing = {
  get: () =>
    Effect.suspend(() =>
      held !== undefined && held.until > Date.now()
        ? Effect.succeed(held.value)
        : Effect.tryPromise({
            try: async () => {
              held = await mint();
              return held.value;
            },
            catch: cause => new TokenError({ cause }),
          })
    ),
};

export const layerRefreshing = Layer.succeed(TokenSource, refreshing);

/* A policy that gives up after three tries, and a source of bytes. */

export const layerThrice = Layer.succeed(RetryPolicy, {
  schedule: Schedule.recurs(3).pipe(Schedule.addDelay(() => '1 second')),
});

export const layerCounting = Layer.sync(EntropySource, () => {
  let at = 0;
  return { bytes: count => Uint8Array.from({ length: count }, () => at++ % 256) };
});

/* The checks a plugin author runs. This block is in the README too. */

export const conforms = Effect.gen(function* () {
  const store = yield* SessionStore;
  const assembler = yield* PromptAssembler;
  const wrongInStore = yield* checkStore(store);
  const wrongInAssembler = checkAssembler(assembler);
  return [...wrongInStore, ...wrongInAssembler];
});
