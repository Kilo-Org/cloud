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
policy under it. Every one of them is still a plugin. A caller who needs a token
that refreshes, or a catalog that asks the gateway, composes the layers
themselves — see "Plugin points" below.

The session is scoped, so `Effect.scoped` is not optional: closing the scope is
what tells the store to write what it still holds.

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
apart.

The handle also carries `history` (every turn, as a plain array), `usage` (the
counts of every call so far — pass it to `hitRatio`), and `compact`.

One session answers one question at a time. A second question asked while the
first is still streaming fails with `SessionBusyError` rather than queueing.

## Storing a conversation

Without a store a session runs in memory and cannot be continued. With one,
every turn is written as it happens.

```ts
import { DatabaseSync } from 'node:sqlite';
import { layerNodeStore } from '@kilocode/harness-sdk/plugins/store/node';

const store = layerNodeStore(new DatabaseSync('sessions.db'));
const program = Effect.provide(work, Layer.mergeAll(layers, store));
```

`layerExpoStore` is the same store on Expo's SQLite. Both are the same
implementation over a one-function driver, so a session written on one reads
back on the other.

Then `continueSession(id)` reopens a stored session, and `cloneSession(id)`
copies its turns onto a new one so a conversation can branch without paying to
build its prefix again. Both take the options from the store, never from the
caller: a system prompt that differs by one byte drops the whole cached prefix,
and the only symptom is the bill.

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
does — one changing subject, say.

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
| `@kilocode/harness-sdk` | Everything: the core and every plugin the package owns |
| `@kilocode/harness-sdk/core` | The contracts and the pure domain, no plugin |
| `@kilocode/harness-sdk/plugins/gateway` | The gateway plugin on its own |
| `@kilocode/harness-sdk/plugins/prompt` | The assembler on its own |
| `@kilocode/harness-sdk/plugins/store/node` | The store on `node:sqlite` |
| `@kilocode/harness-sdk/plugins/store/expo` | The store on `expo-sqlite` |
