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
6. Make every part pluggable. If a part can be a plugin, make it a plugin.
7. Own the core plugins. The package ships its own default for each plugin
   point.
8. Use a library when a library does the work. Do not write what a dependency
   already gives you. If you write more than about ten lines of a solved
   problem, say which library you rejected and why.

   | Job | Library |
   |---|---|
   | Identifiers | `ulid` (`monotonicFactory`) |
   | Server-sent events | `eventsource-parser` |
   | Schemas and validation | `zod` |
   | Effects, streams, retry, layers | `effect` |
   | Request body shapes | `@anthropic-ai/sdk` and `openai`, types only |

   The two model SDKs are imported with `import type` and never called, so they
   add no runtime code. They make the compiler reject a wrong field name in a
   request body.
9. Prove behavior with a local end-to-end run.
10. Validate every incoming value with Zod at the edge. An edge is any point
    where a value enters from outside the package: a store, a model reply, a
    tool result, a caller's input. Do not validate a value the package already
    made; that costs CPU and proves nothing.
11. Keep the package maintainable. Keep a file small and give it one job. If a
    file passes about 100 lines, split it.
12. Keep the core free of a runtime. The package must run on Node, in a
    browser, and in a mobile app. Do not import `node:`, `Buffer`, `process`,
    or a DOM type. A runtime belongs in a plugin. `tsconfig.json` sets
    `"types": []` to enforce this.

## Performance

These are requirements, not goals:

- Use the least CPU.
- Use the least RAM.
- Keep the model cache hit ratio above 95 percent.

A change that adds an allocation on a hot path needs a measurement. A change
that reorders or rewrites the prompt prefix breaks the cache; treat it as a
regression until a measurement says otherwise.

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

`pnpm test:e2e` calls the real gateway with the kilo CLI token from
`~/.local/share/kilo/auth.json`. It never prints the token. It spends a small
amount of real credit.

It asks two questions in one session and checks the second call. The system
prompt is long on purpose: the cached prefix must clear the model's minimum,
which is 4096 tokens on Haiku 4.5, or nothing caches and the check fails for the
wrong reason.

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

Measured on 2026-09-03, five turns each, the Kilo organization:

| Model | Recalled | Cache read | Input | Ratio |
|---|---|---:|---:|---:|
| `openai/gpt-5.6-luna` | yes | 56324 | 15 | 0.9997 |
| `z-ai/glm-5.3-flash` | yes | 34560 | 21754 | 0.6137 |
| `deepseek/deepseek-v4-flash-0731` | yes | 56320 | 324 | 0.9943 |
| `tencent/hy4-preview` | — | — | — | 404, not allowed for the team |
| `xiaomi/mimo-v2.5` | yes | 57600 | 194 | 0.9966 |
| `tencent/hy3` | yes | 55808 | 491 | 0.9913 |
| `deepseek/deepseek-v4-flash` | yes | 56320 | 324 | 0.9943 |
| `minimax/minimax-m3` | yes | 57009 | 75 | 0.9987 |
| `nvidia/nemotron-3-ultra-550b-a55b` | yes | 40960 | 17899 | 0.6959 |
| `google/gemini-3.7-flash` | yes | 40755 | 17884 | 0.6950 |

Every served model took the `messages` shape. Two lessons hold beyond this run:

- **The ratio is the provider's, not the package's.** The package places the
  same breakpoints for every model. A provider that caches on its own terms
  lands near 0.99; one that does not lands near 0.6, and it varies between runs
  on the same model. Do not chase a low number as if it were a defect here.
- **A small token budget reads as a broken transport.** At 64 tokens, four of
  these ten answered nothing: a reasoning model spends the budget before it
  writes a word. The run uses 1024.

### Effort is not the token ceiling

`maxTokens` is a wall the server enforces and the model cannot see. `effort` is
a dial the model follows. A reasoning model pays for its thinking out of
`maxTokens`, so the two meet, but one does not replace the other.

Measured on 2026-09-03 at 64 tokens with `effort: 'low'`:

| Model | Shape | Answers |
|---|---|---|
| `xiaomi/mimo-v2.5` | messages | 4 of 5, up from 1 |
| `z-ai/glm-5.3-flash` | messages | 4 of 5, up from 4 |
| `tencent/hy3` | messages, then completions | 0 of 5 either way |
| `deepseek/deepseek-v4-flash` | completions | 1 of 5 |

Low effort helps, and it does not rescue a wall that is too low. Raise
`maxTokens` first; reach for `effort` to cut cost once answers arrive.

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
3. The `TokenCeiling` plugin, when neither names a number.

The right ceiling belongs to the application, not to the package, which is why
it is a plugin. The package ships `layerFixedCeiling(4096)` and no opinion
beyond it. A model-aware plugin that reads a model's own output limit is the
obvious next one.

One session answers one question at a time. A semaphore holds the second
question until the first is finished, because two answers built on one prefix
means the second one misses the cache.

An answer turn is added only when the stream reaches `done`. A half written turn
would sit in the prefix of every later request.

### The session does not write to the store

`appendTurn` is a pure function. It does not touch the `SessionStore` plugin.
Do not make it write through.

- A pure append has no error channel and no requirement, so no caller inherits
  a store failure.
- The runner flushes once per step, so one step is one transaction, not one
  transaction per turn.
- A session runs with no store at all. This is what lets the package run in a
  browser or in a mobile app.

The cost is that a crash drops whatever the store still holds. That is the
store plugin's call: it is told about every turn as it happens, and about the
close, and it decides whether to write at once, to batch, or to buffer.

### A reloaded turn must equal the turn that was written

The prompt prefix is rebuilt from the store. If `load` returns a turn that
differs from the written turn in one byte or in the order, the prefix changes
and the model cache misses. The SQLite plugin must prove the round trip with a
local end-to-end run.

## Layout

`core/` holds the contracts and the pure domain. `plugins/` holds the
implementations, including the ones this package owns. **A file in `core/` must
never import from `plugins/`.** `pnpm check:boundaries` fails when one does.

| Path | Purpose |
|---|---|
| `src/index.ts` | The public entry point; core and every owned plugin |
| `src/core/run.ts` | `openSession`: the handle a consumer drives |
| `src/core/ask.ts` | One question and one answer, with the turn rules |
| `src/core/usage.ts` | Token counts and the cache hit ratio |
| `src/core/session.ts` | The session and its append-only turns |
| `src/core/turn.ts` | One turn, shaped as one SQLite row |
| `src/core/prompt.ts` | The `Prompt` shape and the `PromptAssembler` plugin point |
| `src/core/model.ts` | The `ModelClient` plugin point; transport only |
| `src/core/storage.ts` | The `SessionStore` plugin point; no plugin yet |
| `src/core/id.ts` | The `IdGenerator` plugin point |
| `src/core/ceiling.ts` | The `TokenCeiling` plugin point |
| `src/core/fetch.ts` | The smallest `fetch` a transport plugin needs |
| `src/plugins/id/ulid.ts` | The identifier plugin |
| `src/plugins/ceiling/fixed.ts` | One ceiling for every model |
| `src/plugins/model/fake.ts` | A scripted model, for tests without a network |
| `src/plugins/prompt/default.ts` | The assembler plugin |
| `src/plugins/gateway/` | The kilo gateway plugin |
| `.oxlintrc.json` | The package lint config; stricter than the root config |
| `tsconfig.json` | The package compiler config; stricter than the root config |

Inside `src/plugins/gateway/`:

| Path | Purpose |
|---|---|
| `index.ts` | The layer: shape choice, send, stream |
| `http.ts` | The post, the headers, and the retry |
| `api-kind.ts` | The three shapes and which one to pick |
| `sse.ts` | A reader over `eventsource-parser` |
| `wire/` | One file per shape, plus the shared `Wire` |
| `fake.ts` | The fake `fetch` the gateway tests share |

Each plugin has its own entry point, so a consumer takes only what it uses:
`@kilocode/harness-sdk/core`, `/plugins/gateway`, `/plugins/id`,
`/plugins/prompt`.

## Recorded deviations

Every rule below is off because it costs more than it gives. Add a row when you
turn one off, and give the reason.

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

`new-cap` stays on with `Tag` and `GenericTag` as exceptions, because
`Context.Tag` is a call, not a constructor.

`isolatedDeclarations` is off. It cannot infer a Zod schema type, and the
package ships its source, so it buys no build time.

`import/group-exports` stays on. Declare a name, then export it in one
`export type { ... }` block and one `export { ... }` block at the end of the
file.
