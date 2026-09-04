# @kilocode/harness-sdk

The SDK that runs a coding agent harness. It holds a conversation with a model,
keeps the model cache warm, stores the conversation, and summarises it when it
outgrows the window.

It runs on Node and on React Native. Nothing in the core names a platform:
`fetch` and the source of random bytes are plugins, so the same code runs in
both places.

Contributors: read `AGENTS.md`.

## Ask a question

```ts
import { Effect, Stream } from 'effect';
import { layerKilo, openSession } from '@kilocode/harness-sdk';

const layers = layerKilo({
  baseUrl: 'https://app.kilo.ai',
  org: { kind: 'organization', id: 'org_...' },
  fetch: myFetch, // see "Your fetch" below
  token: '...',
});

const program = Effect.gen(function* () {
  const session = yield* openSession({ system: 'You are terse.', model: 'anthropic/claude-haiku-4.5' });
  yield* Stream.runForEach(session.ask('Name three fruits.'), event =>
    Effect.sync(() => {
      if (event.kind === 'delta') {
        process.stdout.write(event.text);
      }
    })
  );
});

await Effect.runPromise(Effect.scoped(Effect.provide(program, layers)));
```

A model this knows nothing about is assumed to speak all three gateway shapes,
and the best one it actually speaks is used. Name what a model can do in
`models`, or change the assumption with `fallback` — that is also where a
context window goes, and without one a session never compacts.

`layerKilo` is the wiring almost every caller writes: the prompt assembler, the
entropy source, the model catalog, and the gateway with its token and retry
policy under it. Every one of them is still a plugin. `token` also takes a
source that is asked per call — see "A credential that expires" — and a caller
who needs a catalog that asks the gateway composes the layers themselves; see
"Plugin points" below.

## Your fetch

The package never calls a runtime's `fetch` itself. It declares the smallest
part of one it uses and the caller adapts theirs, which is what lets the same
code run on Node, in a browser, and in a mobile app. The adapter is short, and
this is the whole of it on any runtime with a WHATWG `fetch`. It is
`e2e/node-fetch.ts` in this package, which every live run uses:

```ts
import type { FetchLike } from '@kilocode/harness-sdk';

const decoded = async function* decoded(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield decoder.decode(chunk, { stream: true });
  }
};

const myFetch: FetchLike = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    // Your runtime's own signal type. Dropping it leaves a cancelled call
    // still running, and still being charged for, on the provider.
    signal: (request.signal ?? null) as AbortSignal | null,
  });
  const body = response.body;
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    ...(body === null ? {} : { stream: () => decoded(body) }),
  };
};
```

The package cannot ship this. That one cast is the reason: `AbortLike` is
deliberately not `AbortSignal`, so only code that has the runtime's own type can
join the two, and that code is yours. React Native needs its own adapter anyway,
because its `fetch` does not stream a response body without a polyfill.

## What comes back

`ask` returns a stream of events, in the order the provider sent them.

| Event | Carries |
|---|---|
| `delta` | A piece of the answer's text |
| `reasoning` | A piece of the model's thinking, and the signature that closes it |
| `redacted` | Thinking the provider encrypted. There is nothing here to show a reader |
| `done` | This call's token counts, and why the model stopped |

`done` is always last, and it is the only event that reports usage. `stop` is
one of `end`, `maxTokens`, `refusal`, or `unknown`: an answer cut off at the
ceiling is not a finished answer, and a caller that retries needs to tell them
apart. `maxTokens` covers both walls — the ceiling you set and the model's own
context window — because both leave half a sentence. `unknown` means no frame
said why, which on the shapes served here means the stream ended early; treat
it the same way.

```ts
yield* Stream.runForEach(session.ask('Name three fruits.'), event =>
  Effect.sync(() => {
    if (event.kind === 'delta') {
      process.stdout.write(event.text);
    }
    if (event.kind === 'done' && event.stop === 'maxTokens') {
      // The answer stopped mid-sentence. Ask again with a higher maxTokens,
      // or tell the reader — storing it as finished builds every later
      // request on half a thought.
      process.stdout.write('\n[cut off at the token ceiling]\n');
    }
  })
);
```

The handle also carries `history` (every turn, as a plain array), `usage` (the
counts of every call so far — pass it to `hitRatio`), and `compact`.

One session does one thing at a time. A second question, or a `compact`,
started while the first answer is still streaming fails with
`SessionBusyError` rather than queueing.

## Stopping a question

Interrupt the fiber reading the stream. That aborts the request through the
`signal` your `fetch` adapter passes on, so the provider stops sending.

```ts
const reading = yield* Effect.fork(Stream.runDrain(session.ask('Count to 300.')));
// ...a stop button, a timeout, a closed tab
yield* Fiber.interrupt(reading);
```

The exchange leaves nothing behind: no answer arrived, so the question goes
back out of the conversation with it, and the session is free for the next
question. What this cannot promise is that the provider stops charging —
nothing the package can read reports that. `pnpm test:e2e:cancel` proves the
rest against a real call.

## When it fails

Every failure is a tagged error, so `Effect.catchTag` picks one out by name.
`ask` and `compact` fail with the first three; the rest reach a caller who
opens a stored session or wires the plugins by hand.

| Tag | Means | What a caller does |
|---|---|---|
| `harness/ModelError` | The call did not come back. `reason` is `transport`, `status`, `body`, `unsupported`, or `stream`, and `status` is the HTTP status when there is one | The retry policy has already tried. A `status` of 402 or 429 is the account, not the code. A `stream` failure arrived after the answer started, so throw the fragment away and ask again |
| `harness/StoreError` | The store could not read or write. `operation` names which one | The turn is in memory and the answer is intact. The conversation cannot be continued later |
| `harness/SessionBusyError` | A second question, or a compaction, was started while the first answer was still streaming | Wait for the stream to end, then try again |
| `harness/SessionNotFoundError` | `continueSession` or `cloneSession` was given an id the store does not hold | Open a new session |
| `harness/TokenError` | The `TokenSource` could not produce a credential | Reported as a `ModelError` with `reason: 'transport'`, because it is the one failure this package cannot tell from a flaky network |
| `harness/CatalogError` | The catalog does not know the model | Never fatal on its own: the ceiling falls back to 4096 and compaction is skipped |
| `harness/EntropyError` | The runtime gave no random bytes | The layer fails to build, so no session opens |

A question that fails leaves the session as it was. The question and the answer
reach the store together or not at all, and an unanswered question is taken back
out of memory, so the next request builds on the same prefix rather than asking
again for something the model may still answer late.

## Storing a conversation

Without a store a session runs in memory and cannot be continued. With one,
every turn is written as it happens.

```ts
import { DatabaseSync } from 'node:sqlite';
import { layerNodeStore } from '@kilocode/harness-sdk/plugins/store/node';

const store = layerNodeStore(new DatabaseSync('sessions.db'));
const program = Effect.provide(work, Layer.mergeAll(layers, store));
```

This needs Node 22.13 or newer, which is where `node:sqlite` stopped asking for
`--experimental-sqlite`. On 22.5 to 22.12 the import fails unless the flag is
passed, and before 22.5 the module does not exist.

`layerExpoStore` is the same store on Expo's SQLite, which the caller supplies:
it is an optional peer dependency, because its types name it. Both stores are
the same implementation over a one-function driver, so a session written on one
reads back on the other.

Then `continueSession(id)` reopens a stored session, and `cloneSession(id)`
copies its turns onto a new one so a conversation can branch without paying to
build its prefix again. Both take the options from the store, never from the
caller: a system prompt that differs by one byte drops the whole cached prefix,
and the only symptom is the bill.

A reopened session knows how full it is: the store keeps the provider's count of
the last request beside the session, so one reopened onto a conversation that
already fills the window compacts before it asks anything. `usage` still starts
from zero, because it counts what this run spent.

## Compaction

A session summarises itself when it has filled a share of the model's context
window — 0.8 by default, set with `compactAt`, and the range is 0 to 1. The
trigger is the provider's own count of the last request, so nothing here
estimates and nothing drifts.

This needs the catalog to name a `contextWindow` for the model. Without one the
session never compacts, because a guessed window either cuts a conversation that
fit or fails to save one that did not.

Compaction replaces the conversation with a summary of itself and replays
nothing before it. Keeping the recent turns verbatim looks better and is
refused: a thinking block is signed against the history that stood when it was
made, so a turn replayed after a summary fails on its signature.

`session.compact` runs it now, for a caller who knows sooner than the window
does — one changing subject, say. It takes the same lock a question takes, so
it fails with `SessionBusyError` while an answer is still streaming rather than
rewriting the conversation under it.

## A credential that expires

`token` takes a string or a `TokenSource`. The string is one credential for the
life of the process; the source is asked for every call, which is what a
session outliving its token needs. It is the one plugin most callers replace,
so it is an option here rather than a reason to rewire by hand.

```ts
import { TokenError, TokenSource, type TokenSourceService } from '@kilocode/harness-sdk';

let held: { value: string; until: number } | undefined;

const refreshing: TokenSourceService = {
  // Suspended, so every attempt reads the cache again. A failed call is
  // retried by re-running this effect, so `Effect.succeed(held.value)` would
  // hand the same expired credential to all three attempts.
  get: () =>
    Effect.suspend(() =>
      held !== undefined && held.until > Date.now()
        ? Effect.succeed(held.value)
        : Effect.tryPromise({
            try: async () => {
              held = await mintFromYourAuthServer();
              return held.value;
            },
            catch: cause => new TokenError({ cause }),
          })
    ),
};

const layers = layerKilo({ baseUrl, org, fetch: myFetch, token: refreshing });
```

The call is on the request path, so a source that fetches must cache: the
package asks every time and caches nothing on a plugin's behalf.

The session is scoped, so `Effect.scoped` is not optional: closing the scope is
what tells the store to write what it still holds.

## The model cache

Every design decision here bends toward the cached prefix, because it is most of
the bill and most of the wait.

- Turns are append-only. An earlier turn is never rewritten.
- The system prompt, the model, and the effort are frozen for the life of the
  session. Only `maxTokens` may change per question, because it never reaches
  the prefix.
- A breakpoint is set after the system prompt and on the last turn, which is the
  documented multi-turn shape.
- An image is stored as base64, which is what the wire wants, so it is never
  encoded again.

Measured live: 0.9997 of the input read from the cache on a ten-call session.

The kilo gateway places breakpoints of its own, so the one this package marks
is redundant there today — measured on 2026-09-04 across both providers and all
three shapes, with and without it, on prefixes nobody had sent before. What is
not redundant is everything above it: the gateway's breakpoints need a prefix
that does not move as much as an explicit one would.

The cache is the provider's, and it does not last. Anthropic's entries live
five minutes from the start of the request that wrote or read them, and every
call refreshes them for free — so a session that keeps talking stays warm, and
one that pauses longer than that pays to build its prefix again on the next
question. Nothing here can hold it open, and a low ratio after a pause is not a
fault in your wiring.

## Plugin points

Each of these is a `Context.Tag`, and each ships a default the package owns.

| Point | What it decides | This package ships |
|---|---|---|
| `ModelClient` | How a request leaves and a reply comes back | `layerKiloGateway` |
| `PromptAssembler` | What the prompt looks like, and where the breakpoints go | `layerAssembler` |
| `ModelCatalog` | Which shapes a model speaks, its output limit, its window | `layerTableCatalog` |
| `SessionStore` | Where the conversation is kept | `layerNodeStore`, `layerExpoStore` |
| `TokenSource` | The credential for one call | `layerStaticToken` |
| `RetryPolicy` | What is tried again, and how often | `layerBackoff`, `layerNoRetry` |
| `EntropySource` | Where random bytes come from | `layerWebCrypto`, `layerSeededEntropy` |
| `FetchLike` | Not a tag: the caller passes `fetch` to the gateway | — |

The catalog must be one instance shared by the session and the gateway. Building
it twice typechecks and answers the same, and the two then disagree about a
model the moment one of them is a fetching plugin. `layerKilo` shares it.

## Entry points

| Import | Holds |
|---|---|
| `@kilocode/harness-sdk` | What a caller uses: the layers, the tags, the errors, and the types they carry |
| `@kilocode/harness-sdk/core` | The contracts and the pure domain, no plugin. Wider than the root: it also holds the machinery a session runs on, which a plugin author sometimes needs |
| `@kilocode/harness-sdk/plugins/gateway` | The gateway plugin on its own |
| `@kilocode/harness-sdk/plugins/prompt` | The assembler on its own |
| `@kilocode/harness-sdk/plugins/store/node` | The store on `node:sqlite` |
| `@kilocode/harness-sdk/plugins/store/expo` | The store on `expo-sqlite` |
