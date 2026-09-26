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
part of one it uses, so the same code runs on Node, in a browser, in a Worker
and in a mobile app.

On any runtime that has a WHATWG `fetch`, the adapter ships:

```ts
import { webFetch } from '@kilocode/harness-sdk/plugins/fetch';

const layers = layerKilo({ baseUrl, org, token, fetch: webFetch });
```

It is an entry point of its own, so a caller who brings their own carries
nothing. Every live run in `e2e/` imports it the way a consumer would, which is
how it is proven rather than described.

A runtime without one writes one, and this is the whole of it:

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

That one cast is why the core cannot hold this, and why `webFetch` is a plugin
rather than part of it: `AbortLike` is deliberately not `AbortSignal`, so only
code that has the runtime's own type can join the two. React Native may need its
own adapter, because its `fetch` does not stream a response body without a
polyfill.

## What comes back

`ask` returns a stream of events, in the order the provider sent them.

| Event | Carries |
|---|---|
| `delta` | A piece of the answer's text |
| `reasoning` | A piece of the model's thinking, and the signature that closes it |
| `redacted` | Thinking the provider encrypted. There is nothing here to show a reader |
| `toolCall` | A tool the model asked for, whole: its id, its name, its arguments |
| `toolResult` | What that tool said, and whether it failed |
| `done` | This call's token counts, and why the model stopped |

When only the answer matters, `said` folds the stream into it:

```ts
const answer = yield* said(session.ask('Name three fruits.'));
```

It keeps the words and nothing else. Thinking is not the answer and a tool call
is not the answer, so a round that ran a tool gives back what the model said
after it.

`done` is always last, and it is the only event that reports usage. `stop` is
one of `end`, `maxTokens`, `refusal`, `tools`, or `unknown`: an answer cut off at the
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
counts of every call so far — pass it to `hitRatio`), `compact`, and the three
that work the queue: `queue`, `cancel` and `queued`.

One session does one thing at a time. A second question, or a `compact`,
started while the first answer is still streaming fails with
`SessionBusyError` rather than waiting. To send one anyway, queue it.

## Queueing a message

`ask` answers where you stand, so it cannot wait for a session that is busy.
`queue` is for the other case: a person typing while the last answer is still
arriving. It never refuses. The message joins a line, the line is answered in
the order it formed, and the answer arrives on `continued`.

```ts
const id = yield* session.queue('and what about Lisbon?');

// The line, in the order it will be asked. Show it, or take one back.
const waiting = yield* session.queued;

// True while it is still waiting. False once it has been asked, which is not
// an error: a message the provider has seen cannot be taken back.
const dropped = yield* session.cancel(id);
```

Everything on `continued` names the queued entries its round answers, so one
message's answer is told from another's. A round either says something or was
refused, so narrow before you read it:

```ts
yield* Stream.runForEach(session.continued, one =>
  Effect.sync(() => {
    if (!one.answering.includes(id)) {
      return;
    }
    if ('failed' in one) {
      process.stdout.write(`that one failed: ${String(one.failed)}`);
    } else if (one.event.kind === 'delta') {
      process.stdout.write(one.event.text);
    }
  })
);
```

A refused round is one message's bad news, not the end of the feed. The stream
itself never fails: the session goes on running rounds for the rest of the line,
and a caller whose subscription had died on the first refused round would hear
about none of them.

`done` ends one call to the model, not the round: a round that calls a tool
makes several, and `stop` is `'tools'` on each one that is waiting for a call
the session is about to answer. So a queued message has been answered in full on
the first `done` whose stop is anything else:

```ts
const over = ({ event }: Continued) => event.kind === 'done' && event.stop !== 'tools';
```

The rounds happen whether or not anybody reads `continued`. A caller that does
not watch loses the events, never the work, and `history` holds all of it. The
stream replays its recent events to a new reader, so queueing a message and only
then subscribing still shows you the answer.

## Tools

A tool is a definition and a function that answers a call. Put every tool the
harness has in the registry; name on each session the ones it may use.

```ts
import { Effect, Layer } from 'effect';
import { openSession, ToolRegistry, type Tool } from '@kilocode/harness-sdk';

const weather: Tool = {
  definition: {
    name: 'weather',
    description: 'The weather in one city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'The city to report on.' } },
      required: ['city'],
    },
  },
  run: call => Effect.succeed(`It is raining in ${String(JSON.parse(call.arguments).city)}.`),
};

const withTools = Layer.merge(layers, Layer.succeed(ToolRegistry, { tools: [weather] }));

const session = yield* openSession({
  system: 'You are terse.',
  model: 'anthropic/claude-haiku-4.5',
  tools: ['weather'],
});
```

The session resolves those names when it opens, and fails with
`ToolMissingError` if the registry does not hold one. A session that started
anyway would send the model a tool it cannot run, and the model would call it.

One question is then one loop: the model answers by asking for tools, the tools
answer, the model is asked again, and only when it stops asking does any of it
reach the store. Nothing a tool does fails the question — a tool that throws, a
name the session does not offer, arguments that are not JSON — because the model
is the only party that can decide what to do about it. Each of those comes back
as a failed result.

The calls of one turn run at once, and the session serialises nothing. A tool
that holds one thing — a terminal, a file, a person — holds a permit beside it:

```ts
const oneAtATime = (run: Tool['run']): Tool['run'] => {
  const permit = Effect.unsafeMakeSemaphore(1);
  return call => permit.withPermits(1)(run(call));
};
```

The permit is the tool's because the thing it protects is the tool's. A session
knows nothing about your terminal, so it is in no position to guard it — and a
session that guarded it would only guard it against itself, which is not where
the second caller comes from. `questionTool` and `todoTool` both do this.

Sessions share nothing. A subagent has its own transcript, counts, queue and
running calls, and no way to observe its parent's.

### A call that outlives the request

Every call is run under a deadline, and every call can outlive it. When the
deadline passes, the model is told the call is still running and carries on with
what does not depend on it; the work keeps going; and when it finally answers,
the session joins the same line a queued message joins, and asks the model about
it without anybody having asked a question.

```ts
const session = yield* openSession({
  system: 'You are terse.',
  model: 'anthropic/claude-haiku-4.5',
  tools: ['question'],
  /* How long the model waits for any tool of this session. 30 seconds by
     default, and a single tool may name its own with `inlineFor`. */
  inlineFor: '5 seconds',
});
```

The round it starts arrives on `continued`, like a queued message's. Several
tool results waiting at the front of the line are answered together, in one
round, because the model asked for those calls in one turn and is waiting on all
of them.

The answer goes back as a turn the conversation says, never as a second tool
result: the call it belongs to was already answered, and every shape refuses a
second result for one call.

### Who decides whether the model waits

Every tool the model is offered carries one extra field, `wait`, and the
schema's `default` is what the tool says about itself:

```ts
const weather: Tool = {
  definition: { name: 'weather', description: 'The weather in one city.', parameters },
  /* What the model is told to do by default. Leave it out and the deadline
     answers: a tool nobody waits any time for advertises false. */
  wait: true,
  run,
};
```

The two tools this package ships say opposite things, and both are right.
`question` says true, because a model asks in order to find something out.
`subagent` says false, because handing a task over is how a model carries on.
Either can be changed by the harness that wires it.

The model's own answer beats both, in either direction: it can give up on a call
the tool expected it to wait for, and wait for one the tool expected it to
abandon. Waiting costs nothing at the provider — tools run between requests,
never during one — so what a waiting model spends is the caller's own stream,
and the caller can cut that short at any moment, which is the next section. A
model that waits still waits under the session's limit, never forever.

The field never reaches the tool: a tool author writes the arguments their tool
takes, and nothing else arrives.

### Sending a running call away

The deadline is a guess made before the call started. Whoever is watching knows
better, so any call the model is waiting on can be sent to the background now:

```ts
const waiting = yield* session.running;
const sent = yield* session.background(waiting[0]?.id ?? '');
```

Nothing is cancelled. The work carries on and answers in a round of its own,
exactly as it would have on the deadline — this is the deadline brought forward.
`background` answers false when the call has already been answered, has already
gone to the background, or was never here.

The same call serves a person pressing a key and an agent deciding it has waited
long enough. The session does not need to know which of them it was.

### The subagent tool

A tool that is a session of its own: its own system prompt, its own model, its
own tools, and a transcript the parent never sees. The parent pays for one
answer rather than for every step that produced it.

```ts
const tools = [
  subagentTool(
    { system: 'You look things up.', model: 'anthropic/claude-haiku-4.5', inlineFor: '5 seconds' },
    layers
  ),
];
```

It takes the layers to run under because a tool is handed no context. They may
be the ones the parent uses or another set entirely, which is how a subagent
runs on a cheaper model than the one that called it.

What crosses back is one string, and never what the subagent said on its way to
its own tools. The counts do not: they belong to the session that spent them, so
`onFinished` hands them over for a caller that is adding up what a conversation
cost. A store does cross, because a session reads it from the context it runs
in — the subagent writes to the same database under a session of its own.

### The time tool

A model does not know what time it is. It knows roughly when it was trained,
says that date as confidently as it says everything else, and is wrong by
however long it has been since.

```ts
import { timeTool } from '@kilocode/harness-sdk/plugins/tools';

const tools = [timeTool({ zone: 'Europe/Amsterdam' })];
```

It takes no arguments: there is nothing about the current time for a model to
choose. UTC and the weekday always come back; `zone` adds the local time as
well, and is the harness's to set rather than the model's, because a model
naming its own zone is guessing.

### The todo tool

A model given a task of several steps forgets one, does two at once, or says it
is finished with a step still open. Writing the steps down and reading them back
is the fix, and every harness writes the same one.

```ts
import { todoTool } from '@kilocode/harness-sdk/plugins/tools';

const tools = [todoTool({ onChanged: todos => draw(todos) })];
```

The model sends the whole list every time rather than a change to it. Patching
needs stable identifiers, models invent them, and a patch against one that does
not exist either fails the call or edits the wrong line. What comes back is the
list as it now stands.

The list belongs to the tool, not to a session, so a registry shared by a parent
and its subagents shares one list. Build a tool per session where that is wrong.

### The question tool

No harness can do without this one and none can write it for itself. Everything about the question is the model's — how many,
what each says, what may be picked, one answer or several, whether it may be
skipped. Everything about the asking is yours, in one function.

```ts
import { questionTool, type Asker } from '@kilocode/harness-sdk/plugins/tools';

const ask: Asker = questions =>
  Effect.forEach(questions, question =>
    Effect.map(promptTheUser(question), text => ({ id: question.id, text }))
  );

const tools = [questionTool(ask)];
```

It refuses to overlap with itself, so two rounds of questions queue rather than
arriving on one person at once. Take as long as you like: a question is the
thing that outlives a request most often, and the round the answer starts is the
one that tells the model what was said. Fail with a `ToolFailure` to choose the
words the model reads when nobody answers.

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

`layerExpoStore` is the same store on Expo's SQLite, which the caller supplies.
It asks for the two methods it calls rather than for `SQLiteDatabase`, so the
package depends on nothing at all and your database still typechecks at the
call. Both stores are the same implementation over a one-function driver, so a
session written on one reads back on the other.

Then `continueSession(id)` reopens a stored session, and `cloneSession(id)`
copies its turns onto a new one so a conversation can branch without paying to
build its prefix again. Both take the options from the store, never from the
caller: a system prompt that differs by one byte drops the whole cached prefix,
and the only symptom is the bill.

The exception is the model, and it is the exception because a session freezes
one. Moving a conversation to another model is a copy of it:

```ts
const onGlm = yield* cloneSession(id, { model: 'z-ai/glm-5.3-flash' });
```

`model` and `effort` are all a clone takes, and they are what a person changing
the model picker asks for. The thinking does not come across — a provider reads
back the signature it issued and refuses one it did not — so the copy carries
what was said, what was shown and what the tools did, and leaves the reasoning
with the model that made it.

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
| `ToolRegistry` | Every tool the harness has. A session names the ones it may use | `questionTool`, `subagentTool`, `timeTool`, `todoTool` |
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

Writing one is an object and a `Layer.succeed`. [PLUGINS.md](./PLUGINS.md) has a
worked example for each point and the invariants that are not in the types.

Two of them are easy to get silently wrong: a store that reorders turns or drops
a signature, and an assembler that rewrites an earlier message, both typecheck
and both cost the whole prefix on every question afterwards. So the package
ships the checks. Run one against yours and assert it found nothing:

```ts
import { PromptAssembler, SessionStore } from '@kilocode/harness-sdk';
import { checkAssembler, checkStore } from '@kilocode/harness-sdk/testing';

const conforms = Effect.gen(function* () {
  const store = yield* SessionStore;
  const assembler = yield* PromptAssembler;
  const wrongInStore = yield* checkStore(store);
  const wrongInAssembler = checkAssembler(assembler);
  return [...wrongInStore, ...wrongInAssembler];
});
```

Each answers a list of what it found, in words that say what is wrong and what
it costs. Neither fails: a store that refuses a write is a finding, not an
exception to handle. `checkStore` writes under identifiers of its own, so it is
safe against a real database.

## Entry points

| Import | Holds |
|---|---|
| `@kilocode/harness-sdk` | What a caller uses: the layers, the tags, the errors, and the types they carry |
| `@kilocode/harness-sdk/core` | The contracts and the pure domain, no plugin. Wider than the root: it also holds the machinery a session runs on, which a plugin author sometimes needs |
| `@kilocode/harness-sdk/plugins/fetch` | `webFetch`, for a runtime with a WHATWG `fetch` |
| `@kilocode/harness-sdk/plugins/gateway` | The gateway plugin on its own |
| `@kilocode/harness-sdk/plugins/prompt` | The assembler on its own |
| `@kilocode/harness-sdk/plugins/tools` | The tools the package ships |
| `@kilocode/harness-sdk/plugins/store/node` | The store on `node:sqlite` |
| `@kilocode/harness-sdk/plugins/store/expo` | The store on `expo-sqlite` |
| `@kilocode/harness-sdk/testing` | `checkStore` and `checkAssembler`, for a plugin author's own test suite |
