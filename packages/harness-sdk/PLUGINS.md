# Writing a plugin

Every replaceable part of this package is a `Context.Tag` and a service
interface of two or three functions. Writing one is three steps:

1. Write an object of the service's shape.
2. Wrap it: `Layer.succeed(TheTag, yourObject)`.
3. Merge it into the layers you already provide.

That is the whole mechanism, and it is the same for all eight points. The rest
of this page is one worked example each, and the invariants that are not in the
types.

```ts
import { Layer, Stream } from 'effect';
import { ModelClient, zeroUsage, type ModelEvent } from '@kilocode/harness-sdk';

const layerEcho = Layer.succeed(ModelClient, {
  stream: request =>
    Stream.fromIterable<ModelEvent>([
      { kind: 'delta', text: `you said ${String(request.prompt.messages.length)} things` },
      { kind: 'done', usage: zeroUsage, stop: 'end' },
    ]),
});
```

Merge that layer in where you build the rest, and the session uses it instead of
the gateway.

Nothing here needs a base class, a decorator, or a registration call. A plugin
is an object, and the layer is how it is handed over.

## Check your plugin before you trust it

Two of the eight are easy to write and easy to get silently wrong. A store that
reorders turns, drops a signature, or loses a column typechecks, answers every
call, and breaks the model cache one reload later. An assembler that rewrites an
earlier message typechecks too, and costs the whole prefix on every question
from then on. Neither shows up as an error; both show up as a bill.

So the package ships the checks. Run one in whatever test runner you already
have and assert the answer is empty:

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
it costs. Empty means it conforms. Neither fails: a store that refuses a write
is a finding, not an exception to handle.

They are at `/testing` and not in the main entry, because nobody runs them in
production and an entry point is what a consumer bundles.

`checkStore` writes two sessions under identifiers of its own, so it is safe to
run against a real database. Run it against a fresh one for the clearest answer.

## The eight points

| Tag | Service | What it decides |
|---|---|---|
| `ModelClient` | `ModelClientService` | How a request leaves and a reply comes back |
| `SessionStore` | `SessionStoreService` | Where the conversation is kept |
| `PromptAssembler` | `PromptAssemblerService` | What the prompt looks like, and where the breakpoints go |
| `ModelCatalog` | `ModelCatalogService` | Which shapes a model speaks, its output limit, its window |
| `ToolRegistry` | `ToolRegistryService` | Every tool the harness has |
| `TokenSource` | `TokenSourceService` | The credential for one call |
| `RetryPolicy` | `RetryPolicyService` | What is tried again, and how often |
| `EntropySource` | `EntropySourceService` | Where random bytes come from |

### ModelClient

One function. It takes a `ModelRequest` and returns a stream of `ModelEvent`.
The session never decides how a request is sent, retried, or parsed. The
example above is a whole one.

Every stream must end with exactly one `done`, carrying that call's counts and
why the model stopped. The session reads nothing else to close a turn. Emit
`toolCall` whole — the id, the name, and the complete arguments — rather than in
fragments; collecting the fragments is the transport's job.

Fail with `ModelError`. A transport that throws instead of failing takes the
session down with it.

### SessionStore

Five functions. `create` records a new session, `read` gives it back, `append`
records one completed exchange, `load` gives the turns back oldest first, and
`flush` writes whatever is still held.

```ts
import { Effect, Layer, Option } from 'effect';
import { SessionStore, type StoredSession, type Turn } from '@kilocode/harness-sdk';

const layerMemory = Layer.sync(SessionStore, () => {
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
```

Fail with `StoreError`, naming the operation that failed.

What the types do not say, and `checkStore` does:

- **A reloaded turn must equal the turn that was written**, part for part,
  including the reasoning signature and the tool call arguments. The prompt is
  rebuilt from these, so a byte that changes moves the whole prefix.
- **The order is the order they were written in.** Identifiers sort that way —
  `makeId` builds a ULID — so ordering by identifier is enough, and is what the
  shipped store does.
- **`append` is one transaction.** The turns and the count describe one request:
  a store that wrote the turns and lost the count hands back a session that does
  not know how full it is.
- **`prompted` is the last one written**, not the first. It decides whether a
  reopened session compacts before its next question.
- **`read` of an unknown session is `None`**, never an empty session.
- **One session's turns never reach another's.**

When to write, whether to batch, and how to recover is yours. The session tells
you on every exchange and on close; nothing else is promised.

### PromptAssembler

One pure function, from a session to a `Prompt`. It is where the model cache is
won or lost, so it holds two invariants, and `checkAssembler` runs both:

1. **The same input gives the same bytes.** No clock, no random value, no key
   order that varies.
2. **Appending a turn changes nothing said before that turn.** `cache` is the
   exception and not content: the breakpoint marks the last message, so it moves
   with every turn while everything sent before it stays as it was.

```ts
const renderPart = (part: TurnPart): readonly PromptPart[] =>
  part.kind === 'text' ? [{ kind: 'text', text: part.body }] : [];

const layerPlain = Layer.succeed(PromptAssembler, {
  assemble: ({ system, turns }) => ({
    system: [{ text: system, cache: true }],
    messages: turns.map((turn, at) => ({
      role: turn.role,
      parts: turn.parts.flatMap(renderPart),
      cache: at === turns.length - 1,
    })),
  }),
});
```

That one drops every part that is not text. The shipped assembler renders all
seven kinds, and hands reasoning back exactly as it came.

Replace it to change what the model is told — a preamble of your own, a
different breakpoint strategy, a transcript that hides some part kinds.

### ModelCatalog

What a model can do. The shipped one is a table the caller writes down; a
plugin can ask the gateway instead.

```ts
const layerEverything = Layer.succeed(ModelCatalog, {
  facts: () => Effect.succeed({ apiKinds: ['messages'], contextWindow: 200_000 }),
});
```

It must answer for a model it has never seen rather than failing, because the
session asks before every request and a session that cannot name its shapes
cannot send anything at all. A plugin that fetches must cache: this sits on the
request path, and one question asks two or three times.

### ToolRegistry

Every tool the harness has, in one service. A session names the ones it may use
and the names are resolved when it opens.

```ts
const layerTools = Layer.succeed(ToolRegistry, { tools: [weather, questionTool(ask)] });
```

A tool is a definition and a function. `run` never fails the session: return a
`ToolFailure` and the model reads it as a failed result and decides what to do.
Say `concurrent: false` for a tool that holds one thing — a terminal, a file, a
person — and the session gives it a permit. Say `inlineFor` for one that usually
outlives a request.

Say `wait` for whether the model waits at all — the session shows it to the
model as that field's default, and reads it from `inlineFor` when you say
nothing. Both are defaults and not rules: the session adds a `wait` field to
every tool it offers, and a model that answers it decides for itself. The field
is taken back off before `run` is called, so do not name a parameter `wait` and
do not expect one.

### TokenSource

The credential for one call. **Read the cache inside the effect**, not while
building it: a `get` that reads it outside hands the same expired credential to
every retry, and no type says so.

```ts
let held: { readonly value: string; readonly until: number } | undefined;

const refreshing = {
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
```

### RetryPolicy

One Effect `Schedule`, which sees the error, so it decides both how long to
wait and whether the error is worth waiting for. The shipped one is exponential
backoff with jitter; `layerNoRetry` is the other end.

```ts
const layerThrice = Layer.succeed(RetryPolicy, {
  schedule: Schedule.recurs(3).pipe(Schedule.addDelay(() => '1 second')),
});
```

### EntropySource

`bytes(count)`, synchronous, because it sits on the identifier path. The
shipped one is the global `crypto`; the seeded one is for a test or a replay.

```ts
const layerCounting = Layer.sync(EntropySource, () => {
  let at = 0;
  return { bytes: count => Uint8Array.from({ length: count }, () => at++ % 256) };
});
```

The **ordering** of an identifier is not pluggable: an identifier must sort by
the order it was made in, or a store rebuilds the prefix in the wrong order and
misses the cache. Only where the randomness comes from is yours.

Every block on this page is typechecked against the source tree, in
`e2e/plugins-check.ts`.

## What is not a plugin

`FetchLike` is not a tag. The gateway takes a `fetch` directly, and a runtime
that has a WHATWG `fetch` needs no adapter of its own: import `webFetch` from
`@kilocode/harness-sdk/plugins/fetch`. It is an entry point rather than part of
the root, so a caller who brings their own carries nothing. The README has the
hand-written version for a runtime whose `fetch` does not stream.

There is no generic `layerModelClient(...)` helper, and there will not be.
`Layer.succeed(ModelClient, yours)` is already one line, it is the Effect idiom
the rest of the package uses, and a second way to say it would be a bigger
surface that saves nobody a keystroke.
