# Harness SDK

`@kilocode/harness-sdk` is the SDK that runs a coding agent harness. Read this
file before you change any file in this package.

## Principles

1. Use the strictest TypeScript settings. Do not relax a compiler flag.
2. Use the strictest oxlint and oxfmt settings. Do not add an inline disable.
3. Write a unit test only if it proves behavior. Do not write a test that
   proves the absence of behavior.
4. Performance is a hard requirement. See "Performance" below.
5. Use Effect (`effect`) for the control flow, the errors, and the resources.
6. Make every part pluggable, where a second implementation is real. A seam
   earns its place by the plugin somebody will actually write. Do not add one
   whose only other implementation would be wrong: see "What is not
   pluggable" below.
7. Own the core plugins. The package ships its own default for each plugin
   point.
8. Use a library when a library does the work. Do not write what a dependency
   already gives you. If you write more than about ten lines of a solved
   problem, say which library you rejected and why.

   | Job | Library |
   |---|---|
   | Server-sent events | `eventsource-parser` |
   | Schemas and validation | `typia` (compile time, via `ttsc`) |
   | Effects, streams, retry, layers | `effect` |
   | Request body shapes | `@anthropic-ai/sdk` and `openai`, types only |

   The two model SDKs are imported with `import type` and never called, so they
   add no runtime code. They make the compiler reject a wrong field name in a
   request body.

   **Rejected: `ulid`.** Its `node` export condition resolves to a build whose
   first line is `import crypto from 'node:crypto'`, and its other build calls
   `detectPRNG()` at module scope, which throws on a runtime with no global
   `crypto` — so importing it either drags a runtime into the core or fails at
   import on a mobile build. `core/id.ts` encodes the ULID itself in about
   forty lines of arithmetic and takes its randomness from a plugin. This is
   the one place the package writes what a library already does, and principle
   12 is why.
9. Prove behavior with a local end-to-end run.
10. Validate every incoming value at the edge with typia. An edge is any point
    where a value enters from outside the package: a store, a model reply, a
    tool result, a caller's input. Do not validate a value the package already
    made; that costs CPU and proves nothing.

    The TypeScript type is the schema. `createIs<T>()` returns a boolean and
    `createAssert<T>()` throws; both are rewritten into inlined checks when
    `ttsc` compiles the file, so no schema object exists at run time.

    Prefer a boolean check on a hot path. Building an error is far more
    expensive than answering no: an is-check that misses costs 0.004 us, and
    an assert that throws costs 2.8 us, which is 700 times as much. Measured
    2026-09-03, Node v24.14.1, macOS arm64, median of 7 runs.
11. Keep the package maintainable. Keep a file small and give it one job. If a
    file passes about 100 lines, split it.
12. Be agnostic about the platform. Anything a runtime does differently is a
    plugin point, not a branch and not an import. Do not reference `node:`,
    `Buffer`, `process`, `globalThis`, or a DOM type anywhere in `core/`.

    There are two such points today. `FetchLike` is how a request leaves, and
    `EntropySource` is where random bytes come from. Both are the same shape of
    problem: every runtime has one, no two agree on where it lives, and a
    package that picks for the caller stops running somewhere.

    `tsconfig.json` sets `"types": []`, which makes a first-party `process` or
    `Buffer` a compile error. That is all it does — it cannot see a
    dependency's own imports, and `skipLibCheck: true` removes the rest of the
    leverage. So the rule is checked by reading the build, not by trusting the
    compiler:

    ```
    grep -rn "node:" dist/            # comments only
    grep -rn "globalThis" dist/core/  # nothing
    ```
13. Measure, do not guess. A decision about performance is made from data.
    Write the benchmark, run it, and put the number in the commit message or
    in this file. "This looks slow" is not a finding, and neither is "this
    should be faster".

    This cuts both ways. Before you optimise, measure that the cost is real
    and that it is worth the change: two of the three debts this package
    recorded in its first pass turned out not to exist, and the obvious fix
    for one of them was twice as slow as the code it replaced.

    Measure the environment too, not just the machine in front of you. A
    validator that is fast on Node is slower where `new Function()` is
    forbidden, so a benchmark run only on Node can ship the wrong library.

    Measure the whole path before you optimise a part of it. This package
    spent its first pass making validation 43 times faster, which was 0.005 us
    of a 7 us path, and did not measure the other 99.9 percent until an
    adversarial review did. Being right about the small number is not the same
    as being right about where the cost is.

## Performance

These are requirements:

- Use the least CPU.
- Use the least RAM.

A change that adds an allocation on a hot path needs a measurement. A change
that reorders or rewrites the prompt prefix breaks the cache; treat it as a
regression until a measurement says otherwise.

The cache hit ratio is a requirement on this package's own work: place the
breakpoints so the prefix stays byte-identical as the session grows. It is not
a requirement on the number a given provider returns, which the package does
not control. See the model run below, where served models range from 0.61 to
0.9997 on identical breakpoints.

### The validator

Measured on the SSE hot path, per streamed token, 200k events, Node v24.14.1,
macOS arm64:

| | codegen allowed | codegen blocked |
|---|---|---|
| zod 4, three schemas per event | 11.3 us | not measured |
| typia, boolean checks | 0.25 us | 0.25 us |

Read the typia row carefully. `JSON.parse` is 0.250 us of it and the checks
are 0.005 us: the row is very nearly the cost of parsing, not of validating.

The second column is what a Cloudflare Worker, an MV3 extension and a React
Native release build see, because all three reject `new Function()`. typia
costs the same in both because its checks are generated at compile time. zod
is slower there, and by how much was never measured — do not quote a figure
for that cell until someone runs it. Do not reintroduce a validator that
builds its checks at run time.

### What a streamed token actually costs

Marginal cost through `openSession`, `ask`, the gateway and a fake transport,
200 turns of history:

| | us / token |
|---|---:|
| the whole path | 7.1 |
| the Effect operator chain in `gateway/index.ts` | 4.7 |
| the same work in one plain loop, no Effect | 0.46 |
| SSE parse and wire read (the validator table above) | 0.25 |
| typia validation alone | 0.005 |

Nothing here is being changed: 7 us per token is 7 ms on a thousand token
answer, against seconds of model latency. The table exists so the next change
to this path argues from data, in either direction.

## The toolchain

The compiler is `ttsc`, not `tsc` or `tsgo`. It is the TypeScript-Go compiler
with a plugin host, and typia's transform runs inside it. Stock `tsc`, `tsgo`
and `tsx` all emit code where every `createIs` and `createAssert` call throws
`no transform has been configured` when it runs.

| Job | Command |
|---|---|
| Typecheck | `pnpm typecheck` (`ttsc --noEmit`) |
| Build | `pnpm build` (`ttsc -p tsconfig.build.json`) |
| Tests | `pnpm test` (vitest, transformed by `@ttsc/unplugin`) |
| End-to-end | `pnpm test:e2e` (`ttsx`, not `tsx`) |

Because the transform rewrites source, the package ships `dist/` and not
`src/`. A consumer importing the TypeScript directly would get the throwing
version. Run `pnpm build` after changing a validated shape, or a dependent
package reads a stale check.

The first `ttsc` run on a machine compiles typia's plugin from Go and takes
minutes. Later runs read a cache and take about a second.

## Rules

- Do not add an abstraction with one implementation, unless it is a declared
  plugin point.
- Do not add a dependency for work that a few lines do.
- Keep the file count low. Put one plugin point in one file.
- Name a file in kebab case. Export a type with `export type`.
- Run `pnpm check` in this directory before you commit. It runs the compiler,
  the linter, the boundary check, and the tests.

## The kilo gateway

`POST {baseUrl}/api/gateway/v1/messages` takes the Anthropic Messages body, so
`cache_control` reaches the model.

| Header | Value |
|---|---|
| `authorization` | `Bearer {user token}` |
| `x-kilocode-organizationid` | The organization id. Leave it out for a personal account. |

The route serves three shapes. A model does not always speak all three, and the
gateway resolves that from the serving provider without publishing it, so the
caller gives the plugin an `apiKinds` function.

| Shape | Path | How it caches |
|---|---|---|
| `messages` | `/api/gateway/v1/messages` | An explicit `cache_control` breakpoint |
| `responses` | `/api/gateway/v1/responses` | A `prompt_cache_key` the caller names |
| `chat_completions` | `/api/gateway/v1/chat/completions` | Whatever the provider does on its own |

The plugin picks `messages` first, then `responses`, then `chat_completions`.
That order is the cache order: an explicit breakpoint beats a key, and a key
beats no control at all.

A call is tried again on a transport failure and on 408, 409, 425, 429, 500,
502, 503, and 504. The retry stops as soon as the status is good, before the
body is read, so a second try never repeats text the caller has already seen.
The older `/api/openrouter` prefix also works; the package does not use it.

## The local end-to-end run

`pnpm test:e2e` asks two questions in one session against the real gateway and
checks that the second call reads the cache the first one wrote. It uses the
kilo CLI token from `~/.local/share/kilo/auth.json`, never prints it, and
spends a small amount of real credit.

The system prompt is long on purpose: the cached prefix must clear the model's
minimum, 4096 tokens on Haiku 4.5, or nothing caches and the check fails for
the wrong reason.

About one run in five fails with a ratio of 0, because the provider has not
made the entry readable yet. Re-run before looking for a bug — a real prefix
regression fails every time, not one time in five.

Measured on 2026-09-03, `anthropic/claude-haiku-4.5`, the Kilo organization:

| Call | input | cache read | cache write |
|---|---:|---:|---:|
| First | 3 | 0 | 11822 |
| Second | 3 | 11822 | 13 |

The second call read the whole prefix and wrote only what the first exchange
added. The hit ratio was 0.9995. That is the healthy shape; a growing `input`
or a repeated large `cache write` means the prefix moved.

`e2e/node-fetch.ts` is the whole Node adapter, about ten lines. That is the
measure of what `FetchLike` asks of a caller.

### Many models, a longer conversation

`pnpm test:e2e:models` holds a five turn conversation with each of the ten most
used models on OpenRouter. The last question can only be answered from the
history, so the run proves the prompt actually carries the conversation.

The last table was measured before the usage merge was fixed, when the gateway
overwrote counts instead of raising them, so a provider echoing zeros in its
last frame scored near zero on counts that were never wrong. It is deleted
rather than kept as a number nobody can cite. Re-run and record a fresh one.

Two lessons hold beyond any one run:

- **The ratio is partly the provider's.** The package places the same
  breakpoints for every model, so a spread across models is not a defect here.
  Read a low number as a question, not a bug — but rule out the package first.
- **A small token budget reads as a broken transport.** At 64 tokens a
  reasoning model spends the budget before it writes a word. The run uses 1024.

### Effort is not the token ceiling

`maxTokens` is a wall the server enforces and the model cannot see. `effort` is
a dial the model follows. A reasoning model pays for its thinking out of
`maxTokens`, so the two meet, but one does not replace the other.

Measured at 64 tokens: low effort raised answers on two of four models and
rescued none of the models that answered nothing. Raise `maxTokens` first;
reach for `effort` to cut cost once answers arrive.

## Decisions

### The session bridges; the plugin decides

`openSession` resolves every plugin once, at open, so the handle it returns
carries no requirement. It then tells each plugin what happened and lets the
plugin decide what to do about it. The session never decides when a store
writes, how a transport retries, or how an identifier is made.

Three values are frozen for the life of a session: the system prompt, the model,
and the effort. The system prompt is the front of the cached prefix, a cache
belongs to one model, and a change of effort invalidates the messages cache.
Changing any of them mid-session throws the cache away, so the type does not
allow it.

`maxTokens` is not frozen. It never reaches the rendered prefix, so it costs no
cache. Three places may set it, and the nearest one wins:

1. The question: `session.ask(text, { maxTokens })`.
2. The session: `openSession({ maxTokens })`.
3. The `ModelCatalog` plugin's `maxOutputTokens`, when neither names one.
4. `4096`, when the catalog names none either.

One session answers one question at a time, because two answers built on one
prefix means the second one misses the cache. A second question asked while
the first still streams fails with `SessionBusyError`.

It is refused rather than queued. Queueing cannot work: under `Stream.merge`
the merged stream holds every child resource until all children finish, so the
first question cannot release what the second waits on, and the acquire is
uninterruptible, so `Effect.timeout` cannot break the deadlock either. Four
acquire shapes were tried and every one that waits deadlocks.

An answer turn is added only when the stream reaches `done`. A half written turn
would sit in the prefix of every later request.

### The session does not write to the store

`appendTurn` is a pure function. It does not touch the `SessionStore` plugin.
Do not make it write through.

- A pure append has no error channel, so no caller inherits a store failure.
- One step is one transaction, not one transaction per turn.
- A session runs with no store at all.

The cost is that a crash drops whatever the store still holds. That is the
plugin's call: it hears every turn and the close, and decides whether to write
at once, to batch, or to buffer.

### A reloaded turn must equal the turn that was written

The prompt prefix is rebuilt from the store. If `load` returns a turn that
differs from the written turn in one byte or in the order, the prefix changes
and the model cache misses. The SQLite plugin must prove the round trip with a
local end-to-end run.

## What is not pluggable, and why

Two seams were cut after they were built. Both failed the same test: name the
second implementation, and say whether a caller should be allowed to write it.

**The identifier ordering.** An identifier must sort by the order it was made
in, because a store rebuilds the prompt prefix in that order. A plugin
returning a random identifier typechecks, passes every test, and breaks the
cache one reload later. The ordering is not a choice; where the randomness
comes from is, and that is `EntropySource`.

**The token ceiling.** It was the third of three ways to set one number and
fired only when a caller set neither of the other two. `ModelCatalog` already
knows a model's own limit, so `ask.ts` reads
`maxTokens ?? catalog maxOutputTokens ?? 4096`.

## Layout

`core/` holds the contracts and the pure domain. `plugins/` holds the
implementations, including the ones this package owns. **A file in `core/` must
never import from `plugins/`.** `pnpm check:boundaries` fails when one does.
It exempts `*.test.ts`: a core test needs a plugin to run against.

| Path | Purpose |
|---|---|
| `src/index.ts` | The public entry point; core and every owned plugin |
| `src/core/index.ts` | The `/core` entry point; every core module, no plugin |
| `src/core/run.ts` | `openSession`: the handle a consumer drives |
| `src/core/ask.ts` | One question and one answer, with the turn rules |
| `src/core/usage.ts` | Token counts and the cache hit ratio |
| `src/core/session.ts` | The session and its append-only turns |
| `src/core/turn.ts` | One turn, shaped as one SQLite row |
| `src/core/prompt.ts` | The `Prompt` shape and the `PromptAssembler` plugin point |
| `src/core/model.ts` | The `ModelClient` plugin point; transport only |
| `src/core/storage.ts` | The `SessionStore` plugin point; no plugin yet |
| `src/core/id.ts` | `{prefix}_{ulid}`; the encoding, and the monotonic order |
| `src/core/entropy.ts` | The `EntropySource` plugin point; random bytes |
| `src/core/catalog.ts` | The `ModelCatalog` plugin point; shapes and output limit |
| `src/core/token.ts` | The `TokenSource` plugin point; the credential per call |
| `src/core/retry.ts` | The `RetryPolicy` plugin point; an effect `Schedule` |
| `src/core/fetch.ts` | The smallest `fetch` a transport plugin needs |
| `src/plugins/model/fake.ts` | A scripted model, for this package's tests. Excluded from `dist/` |
| `src/plugins/prompt/default.ts` | The assembler plugin |
| `src/plugins/catalog/table.ts` | A catalog the caller writes down |
| `src/plugins/entropy/web-crypto.ts` | The default source: the global `crypto` |
| `src/plugins/entropy/seeded.ts` | A repeatable source, for a test or a replay |
| `src/plugins/token/static.ts` | One token for the life of the process |
| `src/plugins/retry/backoff.ts` | Exponential backoff with jitter, and no-retry |
| `src/plugins/gateway/` | The kilo gateway plugin |
| `.oxlintrc.json` | The package lint config; stricter than the root config |
| `tsconfig.json` | The package compiler config. The repo has no root `tsconfig.json`; this one stands alone |

Inside `src/plugins/gateway/`:

| Path | Purpose |
|---|---|
| `index.ts` | The layer: send, stream, and the resolved plugins |
| `wires.ts` | Asks the catalog and picks the best wire for a model |
| `test-gateway.ts` | The gateway with test plugins, for the unit tests. Excluded from `dist/` |
| `http.ts` | The post, the headers, and the retry |
| `api-kind.ts` | The three shapes and which one to pick |
| `sse.ts` | A reader over `eventsource-parser` |
| `wire/` | One file per shape, plus the shared `Wire` |
| `fake.ts` | The fake `fetch` the gateway tests share. Excluded from `dist/` |

There are four entry points: `@kilocode/harness-sdk`, `/core`,
`/plugins/gateway` and `/plugins/prompt`. The catalog, token and retry plugins
have none — a consumer reaches them through the root barrel, which also pulls
the gateway. Add a subpath when one of them is wanted on its own.

`pnpm build` empties `dist/` first. It once did not, and a subpath whose source
had been deleted went on resolving against a stale artifact.

## Recorded deviations

Add a row when you turn one off, and give the reason.

| Rule | Reason |
|---|---|
| `import/no-named-export` | This package is a library. A barrel needs named exports. |
| `import/consistent-type-specifier-style` | It deadlocks with `consistent-type-imports` and `no-duplicate-imports`. Inline `type` specifiers win. |
| `no-ternary` | A ternary is the normal form for a two-branch expression. |
| `sort-imports` | It sorts by member syntax, which no formatter keeps. |
| `id-length` | Effect names its type parameters `A`, `E`, and `R`. |
| `vitest/no-importing-vitest-globals` | An explicit import beats a global. |
| `vitest/prefer-to-be-truthy` | `toBe(true)` states the value; `toBeTruthy` does not. |
| `promise/prefer-await-to-then` | It flags `Promise.resolve`. |
| `require-await` | It flags an async generator, which needs no await. |
| `unicorn/no-array-callback-reference` | Effect pipes pass a function by name on every line. |
| `unicorn/no-array-method-this-argument` | It reads `Effect.map(a, b)` as an array method. |
| `func-names` | `Effect.gen` takes an anonymous generator. |
| `no-magic-numbers` | An HTTP status and a token count are not magic. |
| `max-classes-per-file` | A tag and its error belong in one file. |
| `sort-keys` | Field order carries meaning; alphabetical order does not. |
| `import/prefer-default-export` | It deadlocks with `import/no-default-export`. |
| `typescript/require-await` | The same false positive as `require-await`, on the TypeScript side. |
| `typescript/explicit-module-boundary-types` | Off for tests only. A test's helper reads better with an inferred return. |
| `import/max-dependencies` | Off for tests only. A test wires every plugin it exercises. |
| `unicorn/require-module-specifiers` | Off for the config files, which use bare re-exports. |

`skipLibCheck` is on in `tsconfig.json`. `effect` and the two model SDKs ship
declarations this compiler rejects, and the package cannot fix them. It is the
one relaxed compiler flag, and it is the reason principle 12 cannot be enforced
by the type system alone.

`new-cap` stays on with `Tag`, `GenericTag`, `TaggedError` and `TaggedClass`
as exceptions, because each is a call, not a constructor.

`isolatedDeclarations` is off. It cannot infer a typia validator's type.

`import/group-exports` stays on. Declare a name, then export it in one
`export type { ... }` block and one `export { ... }` block at the end of the
file.
