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

    A caller's input is the one edge with no runtime check today, and that is
    a decision rather than an omission. The package ships types, a caller who
    holds them cannot build a bad part without a cast, and a check here would
    need a public error tag of its own for a case nobody has hit. The one
    caller value that is checked is an image's media type, in
    `wire/messages.ts`, because there the shape genuinely cannot carry what a
    string allows. Add the rest when a caller arrives who needs it.

    The TypeScript type is the schema. `createIs<T>()` returns a boolean and
    `createAssert<T>()` throws; both are rewritten into inlined checks when
    `ttsc` compiles the file, so no schema object exists at run time.

    Prefer a boolean check on a hot path. Building an error is far more
    expensive than answering no: an is-check that misses costs 0.004 us, and
    an assert that throws costs 2.8 us, which is 700 times as much. Measured
    2026-09-03, Node v24.14.1, macOS arm64, median of 7 runs.
11. Keep the package maintainable. Give a file one job, and keep it small
    enough to hold in your head. Past about 100 lines, ask whether it has
    picked up a second job; oxlint refuses one past 300.

    Thirteen files are over 100 today and none of them is wrong. A gateway
    shape is one job whether it takes 190 lines or 250, and splitting
    `responses.ts` into a renderer and a reader would make a reader who asks
    "how does this shape work" open two files instead of one. Length is the
    prompt to ask the question, never the answer. Split when the second job
    has a name — that is how `store/sqlite.ts` became four files and how
    `ask.ts` gave up `exchange.ts`.
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
    compiler, and `pnpm check:platform` is what reads it. It runs after
    `pnpm build` as the last step of `pnpm check`, and it fails on an import of
    a Node builtin anywhere, or on `globalThis`, `process` or `Buffer` under
    `core/`. It matches code, not prose: `core/id.ts` names `node:crypto` in a
    comment explaining why it does not import it.
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

The cache hit ratio is a requirement on this package's own work: keep the
prefix byte-identical as the session grows. That, and not the breakpoint this
package marks, is what holds it — measured on 2026-09-04, this gateway places
its own breakpoints and caches the same whether the marker is sent or not. It
is not a requirement on the number a given provider returns, which the package
does not control. See the model run below, where served models range from 0.28 to
0.9997 on identical breakpoints, and where the same model moved from 0.80 to
0.9987 between two runs of the same prompts.

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

What one exchange holds while the reply streams is one record behind one ref,
not a ref per field. Copying the other field on every token costs 0.054 us
against 0.402 for the update itself, measured 2026-09-04 over 200000 rounds —
a third of a percent of what a token costs through the whole session, for one
concept instead of four and a single read at the end. The record is two fields
now: the answer's text, and the thinking as one ordered list. See "Reasoning
goes back exactly as it came" for why the list is not two fields.

Identifiers, measured the same day:

| | us |
|---|---:|
| one identifier, through `Effect.runSync` | 0.86 |
| two identifiers, which is one question | 1.69 |
| one `entropy.bytes(16)` draw | 0.59 |

The draw looks expensive next to the rest, and it is — but the monotonic
counter only draws when the millisecond changes. Measured over 200000
identifiers spanning 179 ms: 180 draws, one per millisecond, 1111 identifiers
each. The cost of randomness is bounded by the clock, not by how many
identifiers are asked for.

That cost does not grow with the answer. Measured 2026-09-04 through the whole
session, one pass each: 19.6 us per token over 200 deltas, 9.3 over 1000, 7.0
over 5000, 7.1 over 20000. The median of five rounds is steadier and lower at
the short end: 13.4 over 200 and 7.1 over 5000. Either way the figure falls and
then flattens, because the fixed cost of opening a session is spread over more
tokens and the append itself is flat. A copy of the answer per delta would be
quadratic, so `pnpm test:perf` compares the short answer against the long one
rather than pinning either number.

Widening the failure reader on 2026-09-04, which added a typia union check to
every frame, cost nothing measurable: 7.11 us per token against 7.04 before it.

Nothing here is being changed: 7 us per token is 7 ms on a thousand token
answer, against seconds of model latency. The table exists so the next change
to this path argues from data, in either direction.

### What a whole request costs before the socket

Everything one question costs on this side, for a 200 turn session and a 200
rule system prompt, measured 2026-09-04 on the same machine:

| | us |
|---|---:|
| `assemble` | 16.8 |
| `messagesWire.toBody` | 5.8 |
| `responsesWire.toBody` | 11.0 |
| `completionsWire.toBody` | 7.5 |
| `JSON.stringify` of the body, 27 kB | 32.0 |
| all three together | 48.1 |

Against that, the ten model matrix reported a median time to the first piece
of the answer between 849 ms and 4064 ms. The whole client path is a
ten-thousandth of the wait, and `JSON.stringify` is two thirds of it — so
there is nothing here worth optimising, and a change that claims to speed up
a request has to say what it is actually speeding up. The perf suite gates it
at 250 us to catch a rewrite that makes it matter.

### What CI runs

`pnpm check` is the local gate. `pnpm check:ci` is the same thing without the
timing gate, which needs a machine nobody else is using, and it is what the
`harness-sdk` job in `.github/workflows/ci.yml` runs whenever a file under
`packages/harness-sdk/` changes.

The job exists for `check:migrations`. The repository's own workspace test job
runs `pnpm test` and nothing else, so without it the inlined SQL could drift
from the schema and every check in the repository would still be green.

The live runs are not in CI and must not be: they cost money and they need a
kilo token.

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
| Timing | `pnpm test:perf` (`vitest.perf.config.ts`, one file at a time) |
| End-to-end | `pnpm test:e2e` (`ttsx`, not `tsx`) |
| One live run | `pnpm test:e2e:` + `image`, `cancel`, `reasoning`, `stop`, `compact`, `shapes`, `session`, `models` |
| Every live run | `pnpm test:e2e:all` (add names to pick a few) |
| Raw frames | `pnpm test:e2e:probe <shape> <model>` (asserts nothing) |

`pnpm test:perf` is a separate config because its files must not run beside the
unit tests: parallel workers compete for the CPU being measured. Its ceilings
are about five times the recorded numbers, so it catches a regression in order
of magnitude and not a busy laptop. A timing test that fails on a loaded
machine would be turned off within a week, which is worth less than no test.

Because the transform rewrites source, the package ships `dist/` and not
`src/`. A consumer importing the TypeScript directly would get the throwing
version. Run `pnpm build` after changing a validated shape, or a dependent
package reads a stale check.

Every test here runs against `src/`; a consumer runs against `dist/`, through
the `exports` map. `pnpm check:package` is the only thing that reads the build
the way a caller does: it imports all six subpaths, asks each for a name it
promises, and then asks one session a question through the built gateway
against a `fetch` that answers from memory. That last part runs a compiled
validator over a stream event, which nothing else does. Both halves were shown
to fail on purpose on 2026-09-04 — a subpath pointed at a file that is not
there, and a built `toDelta` that returns nothing.

The first `ttsc` run on a machine compiles typia's plugin from Go and takes
minutes. Later runs read a cache and take about a second.

**A type error anywhere in `src/` disables the transform everywhere.** typia
bails when the program does not compile, and every `createIs` and
`createAssert` then throws `no transform has been configured` — including in
files that have nothing to do with the error. One unused import in a test file
made `pnpm test:e2e` fail inside `wire/completions.ts`. If a `ttsx` run throws
that message, run `pnpm typecheck` first and read the error it reports, not the
stack it printed.

**A filtered install breaks the same thing, with `pnpm typecheck` still green.**
`pnpm install --filter @kilocode/harness-sdk` left `ttsx` throwing
`no transform has been configured` on 2026-09-04 while `ttsc` and vitest kept
transforming, so only the live runs failed. A full `pnpm install` from the
repository root fixed it. Install for the whole workspace, not for this
package.

## Rules

- Do not add an abstraction with one implementation, unless it is a declared
  plugin point.
- Do not add a dependency for work that a few lines do.
- Keep the file count low. Put one plugin point in one file.
- Name a file in kebab case. Export a type with `export type`.
- Run `pnpm check` in this directory before you commit. It runs the compiler
  over `src/` and over `e2e/`, the linter, the boundary check, the migration
  check, the tests, the build, the platform check, the package check, and the
  timing gate.
- If you change a code block in the README, change `e2e/readme-check.ts` with
  it. It is every README snippet against this source tree, and it is
  typechecked and never run: a snippet that does not compile is worse than no
  snippet. `pnpm typecheck:e2e` is what catches it.

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

| Shape | Path | What it sends about the cache |
|---|---|---|
| `messages` | `/api/gateway/v1/messages` | An explicit `cache_control` breakpoint |
| `responses` | `/api/gateway/v1/responses` | A `prompt_cache_key` the caller names |
| `chat_completions` | `/api/gateway/v1/chat/completions` | Nothing |

**The hit ratio is not comparable between shapes.** `pnpm test:e2e:shapes` asks
the same two questions of the same model through each one:

| Shape | Cache read | Input | Ratio |
|---|---:|---:|---:|
| `messages` | 11224 | 6 | 0.9995 |
| `responses` | 11224 | 11247 | 0.4995 |
| `chat_completions` | 11224 | 11246 | 0.4995 |

All three read the same 11224 tokens, so all three cached equally well. What
differs is the billing of the cold call: `messages` reports the first prefix as
`cache_creation`, and the other two report it as plain input, which the ratio
then divides by. So the ratio measures caching *and* how a provider books a
cache write, and only the `messages` column can be read as a cache figure. Hold
a shape to `cacheReadTokens > 0`, not to a ratio, unless it is `messages`.

The plugin picks `messages` first, then `responses`, then `chat_completions`.
That order is what each shape lets a caller control, best first.

**On this gateway, none of it changes the cache.** Measured on 2026-09-04 with
a prefix nobody had sent before — a nonce in the header and in all 200 system
rules, so the first call of every run is cold and the second measures a cache
that run wrote:

| Shape | Model | Sent | Cache read on the second call |
|---|---|---|---:|
| `messages` | `anthropic/claude-haiku-4.5` | breakpoint | 14032 |
| `messages` | `anthropic/claude-haiku-4.5` | nothing | 14032 |
| `messages` | `openai/gpt-5.6-luna` | breakpoint | 12229 |
| `messages` | `openai/gpt-5.6-luna` | nothing | 12229 |
| `responses` | `openai/gpt-5.6-luna` | `prompt_cache_key` | 12229 |
| `responses` | `openai/gpt-5.6-luna` | nothing | 12229 |
| `chat_completions` | `anthropic/claude-haiku-4.5` | breakpoint | 13630 |
| `chat_completions` | `anthropic/claude-haiku-4.5` | nothing | 13630 |
| `chat_completions` | `openai/gpt-5.6-luna` | breakpoint | 12229 |
| `chat_completions` | `openai/gpt-5.6-luna` | nothing | 12229 |

Every pair is identical to the token, on a native Anthropic model as much as on
a relayed one. The gateway places its own breakpoints, so what this package
sends is redundant there today.

What that does **not** change: the prefix discipline is still what makes the
cache work. Append-only turns, a frozen system prompt, model and effort, and
images kept as the base64 the wire wants — the gateway's own breakpoints need a
stable prefix as much as ours would. Only the marker is redundant, not the rule
that nothing in front of it may move.

`chat_completions` stopped sending its breakpoint on 2026-09-04, because
`cache_control` is not part of that API at all — it was a non-standard field
the gateway would have had to translate, and it bought nothing. `messages`
keeps its breakpoint: it is the documented mechanism for the body being sent,
it costs nothing, and its absence would show up only as a bill if the gateway
ever stopped inserting its own. Re-run the measurement before changing that;
`wire/image.test.ts` holds the method.

A call is tried again on a transport failure and on 408, 409, 425, 429, 500,
502, 503, and 504. The retry stops as soon as the status is good, before the
body is read, so a second try never repeats text the caller has already seen.
The older `/api/openrouter` prefix also works; the package does not use it.

## The local end-to-end run

`pnpm test:e2e:all` runs every live check in one sweep, cheapest first, and
reports one line each. One failure does not stop the rest: the point of a sweep
is to learn everything that broke. Name one or more to run a subset, as in
`pnpm test:e2e:all stop reasoning`. These runs cost real money and real time, so
they are not part of `pnpm check` and never will be.

The whole sweep, 2026-09-04, 3 minutes 46 seconds:

```
PASS  live         7s   the second call read the prefix from the cache
PASS  shapes      11s   every shape carried the conversation
PASS  stop        11s   a finished answer, told from one the ceiling cut off
PASS  image       12s   every shape carried the picture and replayed it
PASS  cancel       9s   the call stopped when the caller did
PASS  session     25s   the prefix held across 10 calls, a busy session refused
PASS  reasoning   25s   every shape took its own thinking back
PASS  compact     11s   the session compacted itself and kept what it was told
PASS  models     115s   10 of 10 models answered every turn
```


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

### The shapes, and a session that grows

`pnpm test:e2e:shapes` forces each of the three shapes by telling the catalog a
model speaks only that one. It exists because every model in the model run
picks `messages`, so the other two shapes had only ever run against a fake
`fetch`.

`pnpm test:e2e:session` asks ten questions of one session and reads the counts
per call. It is the live form of the append-only invariant: the unit test
proves `assemble` does not rewrite an earlier message, and this proves the
provider agrees. Measured on 2026-09-03 with `anthropic/claude-haiku-4.5`:

| Call | input | cache read | cache write |
|---|---:|---:|---:|
| 1 | 3 | 11822 | 0 |
| 2 | 3 | 11835 | 0 |
| 3 | 3 | 11835 | 13 |
| … | 3 | +13 each | 13 |
| 10 | 3 | 11926 | 13 |

Cache read grows by exactly one exchange per call and cache write stays at
exactly that exchange. A prefix that moved would show as a large write on a
late call, which is what the run asserts. It also asks a second question while
the first is still streaming, and requires `SessionBusyError`.

### A picture, and a caller who walks away

`pnpm test:e2e:image` sends a coloured circle through each of the three shapes
and asks what colour it is. Each shape gets a **different** colour, so a model
that never saw the picture would have to guess three specific words to pass.

The second question is the one that matters. It asks whether the background is
white or black, which the first answer never said, so it can only be answered
from the picture. An assembler that dropped the image from the second request
would leave the model with its own earlier word and nothing else. Checked by
returning `[]` for an image part in `assemble`: five of the six assertions fire
and the model answers `i don't see any image attached to your message`.

`pnpm test:e2e:cancel` asks for a long answer twice, reads one to the end, and
walks away from the other after ten pieces. It waits for pieces and not for a
clock, because the time to the first piece is longer than a short wait: a fixed
700 ms only ever cancelled a request that had not started answering.

It asserts four things a fake `fetch` cannot show: the run stops mid-stream
(11 pieces of 76, 1.9 s of 3.3 s), every signal ends aborted, the abort leaves
no unhandled rejection in undici, and the session can still be asked a question
afterwards. Checked by replacing the release with `Effect.void`: the timing does
**not** change, because interrupting the fiber stops the reader either way and
only the socket leaks. The signal assertion is what catches it.

**What neither run proves:** that the provider stops generating and stops
charging. Nothing this package can read reports that.

### The thinking, handed back to the provider

`pnpm test:e2e:reasoning` asks a reasoning model two questions in one session,
so the second request carries the first answer's thinking block. The provider is
the only judge of whether the block is right, and it answers with a status, not
with a different answer.

Measured on 2026-09-04 with `anthropic/claude-sonnet-4.5` at `medium` effort:
363 characters of thinking, one reasoning part stored, a 792 character
signature, and a second answer that built on the first.

Checked on the messages shape by reversing the signature before sending it:

    400 messages.1.content.0: Invalid `signature` in `thinking` block

So that shape does validate it, and a pass means the block went back intact.

**The responses shape carries no such proof.** Reversing its
`encrypted_content` changes nothing: the call succeeds and the answer is right.
So the item is built to the published shape and is sent, and nothing observable
says the provider reads it. Treat that replay as unverified.

Pick a model that thinks. One that does not would pass this run vacuously,
which is why the run fails when a sealing shape reports no thinking.

`pnpm test:e2e:probe <shape> <model>` prints the raw frames of one call. It
asserts nothing; it exists so a question about the wire is answered by reading
the wire. It is how the `response.reasoning.delta` name was found.

### A session that outgrows its window

`pnpm test:e2e:compact` plants a fact, fills a deliberately tiny window with
unrelated talk, and asks for the fact back after the session has compacted
itself. The window is the caller's, not the model's: filling 200k tokens to
test this would cost real money and take an hour, and what is live here is the
summariser, the prompt it builds, and whether the fact survives.

Measured on 2026-09-04 with `anthropic/claude-haiku-4.5` and an 80 token window:
one compaction, and a summary that opens `- Vault code: 4417`. The run reads the
summary itself, not just the answer, because the model could reach the answer
another way.

It also adds up the `done` events. Those are what the caller's own questions
cost, so `session.usage` has to come out above them — the difference is the
summary call, which the caller never asked for and is billed for anyway. The
same run: 70 output tokens against 37 the questions account for.

### Many models, a longer conversation

`pnpm test:e2e:models` holds a five turn conversation with each of the ten most
used models on OpenRouter. The last question can only be answered from the
history, so the run proves the prompt actually carries the conversation.

Measured on 2026-09-04, five questions each, the Kilo organization. `first` is
the median wait for the first piece of an answer, `whole` for all of it:

| Model | Recalled | First | Whole | Cache read | Input | Ratio |
|---|---|---:|---:|---:|---:|---:|
| `openai/gpt-5.6-luna` | yes | 1124 ms | 1309 ms | 56324 | 15 | 0.9997 |
| `qwen/qwen3.8-flash` | yes | 2480 ms | 2481 ms | 59014 | 30 | 0.9995 |
| `minimax/minimax-m3` | yes | 1109 ms | 1122 ms | 57009 | 75 | 0.9987 |
| `xiaomi/mimo-v2.5` | yes | 2023 ms | 2348 ms | 57600 | 194 | 0.9966 |
| `tencent/hy3` | yes | 3143 ms | 3223 ms | 55808 | 491 | 0.9913 |
| `deepseek/deepseek-v4-flash` | yes | 3671 ms | 3671 ms | 54528 | 2116 | 0.9626 |
| `deepseek/deepseek-v4-flash-0731` | yes | 3891 ms | 3948 ms | 53760 | 2884 | 0.9491 |
| `z-ai/glm-5.3-flash` | yes | 1373 ms | 1471 ms | 34560 | 21754 | 0.6137 |
| `google/gemini-3.7-flash` | yes | 2266 ms | 2370 ms | 24432 | 34207 | 0.4167 |
| `nvidia/nemotron-3-ultra-550b-a55b` | yes | 869 ms | 869 ms | 16384 | 42475 | 0.2784 |

Ten of ten answered every turn from the history. Every one used the `messages`
shape.

`tencent/hy4-preview` was in this list and is not served to this team — a 404
reading `model_not_allowed` — so `qwen/qwen3.8-flash` took its place.

The waits are the provider's, not the package's: building a whole request
costs 48 us on this side, against a first piece between 869 ms and 20 s. The
same model varies by a factor of ten between runs — `xiaomi/mimo-v2.5` took
1419 ms on one run, 20 s on the next, and 2023 ms on the one above.

The ratios move too, and by more than the request does. `tencent/hy3` read
0.79 of its input from the cache on one run and 0.99 on the next; `minimax/
minimax-m3` went 0.80 to 0.9987, and `google/gemini-3.7-flash` 0.14 to 0.42, on
the same prompts through the same code. What the ratio measures is whether the
upstream provider still held the prefix, which is its decision and not this
package's. Read one run as weather. The one number that is climate is the top
of the table: a model whose provider caches at all lands above 0.99, and that
has held on every run.

The prompts are identical between runs, so a ratio that fell is the provider
having dropped a prefix it once held, not a change here. Do not chase one.

These ratios are lower than the ones recorded before the usage merge was
fixed, and the lower ones are the honest ones. The earlier table had
`deepseek/deepseek-v4-flash-0731` at 0.9943 on a cumulative input of 324
tokens, which cannot happen: no cache exists on the first call, so the cold
call alone spends the whole prefix as uncached input. Reading the raw frames
for that model shows why the counts move:

```
first call, cold    message_start  {"input_tokens":0,"output_tokens":0}
                    message_delta  {"input_tokens":6899,"output_tokens":44}
second call, warm   message_start  {"input_tokens":0,"output_tokens":0}
                    message_delta  {"input_tokens":125,"output_tokens":39,
                                    "cache_read_input_tokens":6784}
```

This relay puts zeros in `message_start` and the counts in `message_delta`,
which is the inverse of Anthropic direct. Raising rather than overwriting is
right for both: `max(0, 6899)` is 6899 either way round. When you doubt a
count, dump the frames before you reason about the aggregate.

The cache also expires. Anthropic's entries live five minutes, measured from
the start of the request that wrote or read them, and a read refreshes them at
no cost. A `ttl: '1h'` on the `cache_control` block buys an hour at twice the
base input price. This package does not send it: the trade depends on how long
a caller's sessions idle and what its tokens cost, which is the caller's number
and not one this package can guess. Read on 2026-09-04. Anything measured after
an idle gap is measuring the expiry, not the breakpoints.

Two lessons hold beyond any one run:

- **The ratio is partly the provider's.** The package places the same
  breakpoints for every model, the spread above runs from 0.28 to 0.9997 on
  identical breakpoints, and one model moved 0.80 to 0.9987 between two runs
  of the same prompts. Read a low number as a question, not a bug — but rule
  out the package first, and check the arithmetic closes before trusting a
  high one.
- **A small token budget reads as a broken transport.** At 64 tokens a
  reasoning model spends the budget before it writes a word. The run uses 1024.

### Effort is not the token ceiling

`maxTokens` is a wall the server enforces and the model cannot see. `effort` is
a dial the model follows. A reasoning model pays for its thinking out of
`maxTokens`, so the two meet, but one does not replace the other.

Measured at 64 tokens: low effort raised answers on two of four models and
rescued none of the models that answered nothing. Raise `maxTokens` first;
reach for `effort` to cut cost once answers arrive.

The five levels are exactly Anthropic's `output_config.effort` set, checked
against the SDK on 2026-09-04, and a subset of OpenAI's `ReasoningEffort`,
which also has `none` and `minimal`. So every value this package accepts
reaches every shape it can send. Do not add one that only one of them takes.

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

One session does one thing at a time, because two answers built on one prefix
means the second one misses the cache. A second question asked while the first
still streams fails with `SessionBusyError`.

`session.compact` takes the same lock. Compaction rewrites the whole
conversation, and a question in flight holds the session as it stood before it
was asked, to put back if no answer comes; both at once put the pre-summary
session back while the store keeps the summary, and the two then disagree
forever. `whileFree` in `ask.ts` is the lock, and `compactIfFull` does not take
it — it runs inside a question that already holds it.

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

### The store is one shared implementation and a one-function driver

`src/plugins/store/sqlite.ts` holds every query. The seam is `driver.ts`: one
function — run this SQL with these parameters, give back the rows by position —
so `node.ts` and `expo.ts` are about twenty lines each and share all of it.
`rows.ts` says what a row means and asserts it, and `migrate.ts` applies the
migrations the bundle carries.

The schema is written in `schema.ts` and the SQL is generated from it, so a
migration and a query can never disagree about a column. Run `pnpm migrations`
after editing the schema: it calls drizzle-kit and then inlines the SQL into
`src/plugins/store/migrations.ts`.

`pnpm check:migrations` regenerates them and fails when anything moves, so the
schema, the SQL and the inlined copy can never drift apart unnoticed. It is part
of `pnpm check`. That check is the price of inlining, and it is why inlining is
allowed. `pnpm migrations` formats what it writes, so generating twice produces
the same bytes.

**Migrations are inlined, never read from disk.** React Native has no filesystem
to read them from, and Drizzle's answer there is a Babel plugin, which a package
must not force on the people who install it. The applied version lives in
SQLite's own `user_version`, so the store needs no table to know where it
stands, and the whole set is applied in one transaction.

**A Drizzle type states what the schema declares, not what the file on disk
holds.** Every row is asserted with typia on the way out. A database written by
an older build, or by another program, still arrives as `unknown`.

### Three tables, and a read with no join

| Table | Holds |
|---|---|
| `sessions` | What `SessionOptions` freezes: system, model, effort, maxTokens |
| `turns` | The identifier, the session, and the role. No content of its own |
| `parts` | One row per piece of a turn: text, reasoning, or an image |

`parts.session_id` repeats what `turn_id` could reach. It is there for the
reader: loading a session is two indexed scans over two tables and no join at
all, and the parts are matched onto their turns in one pass in memory. Both
indexes cover `(session_id, id)`, so each read is a range over one index with no
sort, because a ULID already carries the order.

A turn and its parts are written in one transaction. A turn whose parts went
missing would read back as an empty message and quietly shorten the prompt.

**An image is stored as base64, not as a blob.** Base64 is what every gateway
shape wants on the wire, so storing it that way costs a third more space and
saves encoding the image again on every single request. The read path is the
prompt builder, and it is the path that matters.

`sessions` records the options because a continued session must be reopened with
them. Resuming under a system prompt that differs by one byte drops the whole
cached prefix, and the only symptom is the bill.

### Reasoning goes back exactly as it came

A reasoning model's thinking arrives as its own stream event and is stored as
its own part, ahead of what the model then said. It is then **sent back
unchanged** with every later request.

Do not strip it. The API drops what the target model cannot read and does not
bill for it, so there are no input tokens to save, and removing a block by hand
can fail the request on ordering or on its signature. Hand back what the
provider gave and let the provider decide.

**The signature is the part that matters.** A provider signs the thinking and
refuses a block whose signature it cannot read, so `TurnPart` carries an opaque
`signature` and the `parts` table has a column for it. The signature streams on
its own event, after the thinking and with no text on it. A reasoning part with
no signature is left out of the prompt: it would only be refused.

**A `redacted_thinking` block is thinking the provider encrypted rather than
showed.** It arrives whole at the start of the block, carries no signature and
no words, and has a part kind of its own so that nothing renders its bytes as
text. It goes back byte for byte. Only the Anthropic shape produces one, and
only for flagged content, so no live run has ever seen one. Anthropic documents
no string that triggers one either — checked on 2026-09-04 against the thinking
and extended thinking pages — so do not spend time looking for a live case.

**The thinking blocks go back in the order the model made them.** Anthropic's
thinking page: within the latest assistant message the sequence of consecutive
thinking blocks must match what the model generated, and it may not be
rearranged, edited, or partly dropped. An encrypted block counts as one of
them, so a turn whose reasoning was redacted part way through is thinking, then
the encrypted block, then more thinking. `Spoken` therefore holds one ordered
list and not a string of words beside a list of encrypted blocks — the two
fields could not say which came first, and this package emitted every encrypted
block ahead of every word until 2026-09-04.

**An empty thinking block is still a block.** A provider returns thinking as a
summary and defaults to no summary at all, so `thinking` is `''` while the model
thought and was billed. The part is kept whenever there is a signature, never on
whether there are words. Dropping empty ones would drop every block on the
default setting.

**Each shape seals the thinking its own way, and the seal is opaque.**
`signature` holds whatever the shape needs to hand the thinking back, and only
that shape knows what is in it:

| Shape | What it seals with | Replays |
|---|---|---|
| `messages` | the signature Anthropic issues with the block | yes |
| `responses` | `{id, encrypted_content}` of the reasoning item, as JSON | yes |
| `chat_completions` | nothing it will take back | no |

A session's model is frozen and its shape follows from the model, so a seal
made by one shape is never read by another.

The responses shape does not carry thinking inside a message. It is an item
beside the message, holding the provider's own encrypted copy, and the request
has to ask for it with `include: ['reasoning.encrypted_content']`. The summary
is replayed empty, which is how the item arrives: a summary this package wrote
instead of the provider would be a change to what the provider sealed.

**The gateway sends the reasoning under different names again.** Measured
2026-09-04: the responses shape relays Anthropic's thinking as
`response.reasoning.delta`, not the documented `response.reasoning_summary_text
.delta`, so both are read. Two providers relayed through the chat shape name it
`reasoning` and `reasoning_content`, so both are read there.

A turn holds as many reasoning parts as the model produced, and an encrypted
block closes the one open at the time. What still merges is two signed blocks
with nothing between them: a signature does not close a block here, so both
land in one part with the second signature. A model produces those between tool
calls, which this package does not have. Split on the signature when it does.

Measured with `pnpm test:e2e:probe responses anthropic/claude-sonnet-4.5` on
2026-09-04: one reasoning item and one message in a turn, 43
`response.reasoning.delta` frames and a single `response.output_item.done`
carrying the reasoning. So the merge loses nothing today, and the probe is how
to check that again.

### A provider may fail after the answer has started

All three shapes may report a failure in the middle of a stream that they would
have reported as a status had the call not been streamed. Anthropic's streaming
reference names the case: an `overloaded_error` frame, which is a 529 on a call
that is not streamed. Two of the three mark it with an `error` object on the
frame. The responses shape marks it one level down, as `response.error` on a
`response.failed` frame, which OpenAI's reference gives a `code` and a
`message`. `isFailure` in `wire/wire.ts` reads both places, once, rather than
three times.

The stream fails with `ModelError` and `reason: 'stream'`. It is a reason of
its own because the caller already holds part of an answer and has to throw it
away; no other reason leaves anything behind. The exchange is never written, so
the fragment reaches the caller and nothing else. Before 2026-09-04 the frame
matched no reader, was dropped as an unknown event, and the stream ended on
`done` with a fragment stored as a whole answer.

Reading a field this way risks calling a good frame a failure, so it was
checked against real traffic: the whole live sweep, the ten model matrix, and
`pnpm test:e2e:probe` on each of the three shapes, all on 2026-09-04. Not one
frame of a call that succeeded carried an `error` object in either place. The
responses shape does send the key on every reply that worked, as
`response.error: null`, and null is not an object, so it does not match. The
probe prints any frame that carries one, so that check takes one command.

### Why the model stopped is part of the answer

`done` carries a `StopReason` beside the counts: `end`, `maxTokens`, `refusal`,
or `unknown`. Without it a caller cannot tell a finished answer from one the
ceiling cut off mid-sentence, and would store half a thought and build every
later request on it.

The truncated turn is still kept. It is what was paid for, and dropping it would
shorten the prompt that follows.

`unknown` is the honest answer for a name this package has not seen, and it is
never a guess. `tool_use` and `tool_calls` map to `unknown` on purpose: this
package has no tools, so naming them would claim a meaning nothing has tested.

It is also what a caller gets when the stream ended and no frame said why. All
three shapes served here always send one, on every live run recorded in this
file, so treat that case the way you treat `maxTokens`: the answer in hand may
not be the whole answer. Whether the package should fail instead of reporting
`unknown` there is open, and needs a live case before anyone decides.

The three shapes report it in three places — `message_delta.delta.stop_reason`,
`response.incomplete.response.incomplete_details.reason`, and
`choices[].finish_reason` — so `pnpm test:e2e:stop` asks each shape twice, once
with room to finish and once with a ceiling of 24 tokens.

`maxTokens` covers two walls on the Anthropic shape. `max_tokens` is the
caller's ceiling and `model_context_window_exceeded` is the model's window, and
the provider's own guidance for the second is to treat it as truncated. Both
leave half a sentence, which is the whole of what the reason has to tell a
caller. The full list, read on 2026-09-04: `end_turn`, `max_tokens`,
`stop_sequence`, `tool_use`, `pause_turn`, `refusal`, and
`model_context_window_exceeded`. `tool_use` and `pause_turn` both wait on
tools.

### A dropped stream stops the call

Every call carries an abort signal, and the handle is scoped to the stream
rather than to the request. A streamed call resolves as soon as the headers
arrive and keeps producing for a long time after, so a handle released when the
request resolved would cancel nothing and the provider would keep charging.

`AbortController` is read off the global, the way the entropy plugin reads
`crypto`, because it is a global in every runtime that has `fetch` and this
package already asks the caller for a `fetch`. A runtime without one still
works and simply cannot stop a call early.

The package declares only the part of a signal it hands on, so an adapter names
the type its own runtime has. `e2e/node-fetch.ts` shows the one line.

### An exchange is written whole, or not at all

The question is added to the session in memory when it is asked, because the
prompt needs it. The **store** hears about the question and the answer together,
in one call, when the stream reaches `done`.

If no answer arrives — the caller walked away, the transport failed, the store
refused the write — the question is taken back out again. A transcript that ends
on an unanswered question sends it again with every later request: the caller
pays for it each time, and the model may answer it late, on top of whatever was
asked next. Seen live before the fix, after a cancelled question:

    asked again    "ok\n\n1\n2\n3\n4\n5\n6\n7"

Rolling back is a `Ref.set` to the session as it stood, which is safe because
one session answers one question at a time and nothing else can have touched it.
`StoredExchange.turns` is a list for the same reason: two appends would leave a
question committed without its answer if the second failed.

### A session that fills the window summarises itself

A session grows until the model refuses the request. Compaction is the answer,
and the shape of it is not a preference:

**Summarise everything into one message and replay nothing before it.** Keeping
the recent turns verbatim and summarising only the old ones looks better and is
refused: a thinking block is signed against the whole history that stood when it
was produced, so a retained turn replayed after a summary fails on its
signature. Nothing carried over here is tied to the old transcript.

The summary is a turn with a `summary` part. `sinceSummary` is the only rule:
a prompt starts at the last turn that holds one. The earlier turns stay in
memory and stay in the store — they are the record of what happened, and only
the prompt starts after them, so a continued session lands in the same place.

**The trigger is the provider's own count.** After each call the session records
what that request put in front of the model, cached tokens included, and
compacts before the next question when it passes `compactAt` (0.8) of the
catalog's `contextWindow`. The count is stored with the session, so a resumed
one is measured too. No tokeniser, and no estimate that can drift. A
catalog that names no window never compacts: a guessed window would either cut a
conversation that fit, or fail to save one that did not.

Compaction throws the model cache away, because every byte of the prefix
changes. That is the price of the session continuing at all. `session.compact`
forces one, for a caller that knows sooner than the number does.

The summariser is told what to keep. Left to its own judgement it writes a
readable paragraph and drops the identifiers, and the summary is all the model
will have of that work.

The summary is streamed and folded, like every other call. `ModelClient` had a
second method that fetched a whole reply, and compaction was its only caller:
one parser per shape that nothing else exercised, free to disagree with the one
that mattered. It did, and this is the bug below. It was deleted on 2026-09-04
along with the three `toReply` readers and `ModelRequest.stream`, which the
gateway overwrote on every call anyway.

**The summary call is counted.** It is a call to the model, it is billed, and
until 2026-09-04 its tokens went nowhere: `session.usage` under-reported every
session that had ever compacted, by the whole cost of every summary. It sets
`prompted` to zero rather than adding to it, which is deliberate — the next
request starts from the summary, so what the last one cost says nothing about
what the next one will.

### The two model SDKs are types, not code

`openai` and `@anthropic-ai/sdk` are the contract the three wires are written
against, and every import of either is a type. Nothing of either survives the
build, so both are dev dependencies and a consumer installs neither: 18.8 MB
unpacked between them, against 4 runtime dependencies that are all used.

That holds only while no published declaration names one. Exporting a type
built out of one — `ContentBlock`, say, which two wires exported and neither
read — puts the import back into a `.d.ts`, and the consumer's own typecheck
then fails on a package nobody told them to add. The compiler here cannot see
it, because here they are installed, so `pnpm check:platform` reads the built
declarations and fails on either name.

The store plugins go the other way. `plugins/store/expo` names `SQLiteDatabase`
in its types, so `expo-sqlite` is an optional peer dependency. `plugins/store/
node` names `node:sqlite`, which needs Node 22.13 or newer to import without a
flag.

### The count is stored beside the session

`prompted` is the provider's own count of the last request, and nothing here
estimates one. So it is written down: a `prompted` column on `sessions`, filled
by `append`, and read back by `continueSession`. A session reopened onto a
conversation that already fills the window compacts before it asks anything.

Until 2026-09-04 it was not stored. A reopened session started at zero, `isFull`
was false, and its first question went out with the whole stored conversation in
front of it. That closed itself after one answer — unless that first question was
the one that would not fit. Then it was refused, `finish` never ran, the count
stayed zero, and every retry was identical: the session could not compact itself
out of it.

`append` therefore takes a `StoredExchange`, not a list of turns: the session,
its new turns, and the count that goes with them. They are one write because
they describe one request. A store that kept the turns and lost the count would
hand back a session that does not know how full it is; one that kept the count
and lost the turns would hand back a session that thinks it is fuller than it
is. The SQLite plugin does both inside the same transaction.

A compaction records zero, in the store as well as in memory. The next request
starts from the summary, so what the last one cost says nothing about what the
next one will. `resume.test.ts` pins both directions: a session whose stored
count fills the window compacts before its first question, and a session
reopened after a compaction does not compact again.

An older database has no column and reads back as absent, which is treated as
zero — the behaviour it had before, for the one session that was mid-flight
when the migration ran.

### A reloaded turn must equal the turn that was written

The prompt prefix is rebuilt from the store. If `load` returns a turn that
differs from the written turn in one byte or in the order, the prefix changes
and the model cache misses. The SQLite plugin must prove the round trip with a
local end-to-end run.

## What is not pluggable, and why

Two seams were cut after they were built, and one default was tried and could
not be written. The two failed the same test: name the second implementation,
and say whether a caller should be allowed to write it.

**The identifier ordering.** An identifier must sort by the order it was made
in, because a store rebuilds the prompt prefix in that order. A plugin
returning a random identifier typechecks, passes every test, and breaks the
cache one reload later. The ordering is not a choice; where the randomness
comes from is, and that is `EntropySource`.

**A shipped `fetch` adapter.** Every caller writes the same twenty lines to
join their runtime's `fetch` to `FetchLike`, and it was tried as
`plugins/fetch/web.ts`. It cannot be written here: `AbortLike` is deliberately
not `AbortSignal`, so the adapter needs one cast that only code holding the
runtime's own type can make honestly, and `no-unsafe-type-assertion` is on for
a reason. The adapter is in the README instead, and in `e2e/node-fetch.ts`
where every live run uses it. React Native needs its own regardless: its
`fetch` does not stream a response body without a polyfill.

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
| `src/index.ts` | The public entry point; what a caller uses, and every owned plugin |
| `src/core/index.ts` | The `/core` entry point; every core module, no plugin |
| `src/core/run.ts` | `openSession`: a new session |
| `src/core/resume.ts` | `continueSession` and `cloneSession`: one the store already holds |
| `src/core/wiring.ts` | What every session shares: the options, the handle, the bridge |
| `src/core/ask.ts` | One question and one answer: the guard, the ceiling, the stream |
| `src/core/exchange.ts` | What an exchange is, and the rule that it is written whole |
| `src/core/usage.ts` | Token counts and the cache hit ratio |
| `src/core/session.ts` | The session and its append-only turns |
| `src/core/turn.ts` | One turn and its parts: text, reasoning, or an image |
| `src/core/prompt.ts` | The `Prompt` shape and the `PromptAssembler` plugin point |
| `src/core/model.ts` | The `ModelClient` plugin point; transport only |
| `src/core/storage.ts` | The `SessionStore` plugin point |
| `src/core/id.ts` | `{prefix}_{ulid}`; the encoding, and the monotonic order |
| `src/core/entropy.ts` | The `EntropySource` plugin point; random bytes |
| `src/core/session-fixture.ts` | What the session tests share. Excluded from `dist/` |
| `src/perf.perf.test.ts` | The timing gate; run by `pnpm test:perf`, not `pnpm test` |
| `src/core/catalog.ts` | The `ModelCatalog` plugin point; shapes and output limit |
| `src/core/token.ts` | The `TokenSource` plugin point; the credential per call |
| `src/core/retry.ts` | The `RetryPolicy` plugin point; an effect `Schedule` |
| `src/core/fetch.ts` | The smallest `fetch` a transport plugin needs |
| `src/plugins/kilo.ts` | `layerKilo`: the five layers a session needs, in one call |
| `src/plugins/model/fake.ts` | A scripted model, for this package's tests. Excluded from `dist/` |
| `src/plugins/prompt/default.ts` | The assembler plugin |
| `src/plugins/catalog/table.ts` | A catalog the caller writes down |
| `src/plugins/entropy/web-crypto.ts` | The default source: the global `crypto` |
| `src/plugins/entropy/seeded.ts` | A repeatable source, for a test or a replay |
| `src/plugins/token/static.ts` | One token for the life of the process |
| `src/plugins/retry/backoff.ts` | Exponential backoff with jitter, and no-retry |
| `src/plugins/store/sqlite.ts` | Every query, written once for every platform |
| `src/plugins/store/driver.ts` | The one-function seam an adapter fills, and `transact` |
| `src/plugins/store/rows.ts` | What comes off the disk, and the assertions that check it |
| `src/plugins/store/migrate.ts` | Applying the migrations the bundle carries |
| `src/plugins/store/node.ts`, `expo.ts` | One adapter per platform |
| `src/plugins/gateway/` | The kilo gateway plugin |
| `README.md` | What a consumer reads: the example, the events, the plugin table |
| `.oxlintrc.json` | The package lint config; stricter than the root config |
| `tsconfig.json` | The package compiler config. The repo has no root `tsconfig.json`; this one stands alone |

Inside `src/plugins/gateway/`:

| Path | Purpose |
|---|---|
| `index.ts` | The layer: send, stream, and the resolved plugins |
| `wires.ts` | Asks the catalog and picks the best wire for a model |
| `test-gateway.ts` | The gateway with test plugins, for the unit tests. Excluded from `dist/` |
| `http.ts` | The post, the headers, the retry, and the abort handle |
| `api-kind.ts` | The three shapes and which one to pick |
| `sse.ts` | A reader over `eventsource-parser` |
| `wire/` | One file per shape, plus the shared `Wire` |
| `fake.ts` | The fake `fetch` the gateway tests share. Excluded from `dist/` |

`layerKilo` is the wiring almost every caller writes: the assembler, the
entropy source, the catalog, and the gateway with its token and retry policy
under it. A model it knows nothing about is assumed to speak all three shapes,
which is true of everything the gateway relays, so the smallest call names four
things: the URL, the org, a `fetch`, and a token. It exists because that wiring
has an order and a trap — the catalog must be one instance shared by the session
and the gateway, not two that agree — and because the package's own live runs
were copying twenty-five lines of it each.

`token` takes a `TokenSourceService` as well as a string. That is the one plugin
a long-lived caller has to replace, because the kilo token expires, and
replacing it by hand means rebuilding the shared catalog — the trap this
function closes. One line here against twelve a caller would have copied. Every
other plugin is still replaced by composing the layers instead.

There are six entry points: `@kilocode/harness-sdk`, `/core`,
`/plugins/gateway`, `/plugins/prompt`, `/plugins/store/node` and
`/plugins/store/expo`. The two stores have subpaths of their own because each
names a platform: exporting them from the root would pull `node:sqlite` or
`expo-sqlite` into every bundle. The catalog, token and retry plugins have
none — a consumer reaches them through the root barrel, which also pulls the
gateway. Add a subpath when one of them is wanted on its own.

The root is narrower than `/core` on purpose. It re-exports whole only the
modules a caller uses whole, and names what it takes from the seven that hold
the machinery a session runs on: `wiringFor`, `makeId`, `sinceSummary`,
`onStore` and the rest are reached through `/core` instead. That is 33 names at
the root rather than 50, and every one of them is in the README.

`src/index.test.ts` asserts both halves, because a module left out of a barrel
is invisible from outside the package and every test here imports by path. It
has caught two unreachable features — compaction and the composed layer — and
it now also fails when a name from the machinery list reaches the root.

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
| `import/no-namespace` | Off for `src/index.test.ts` only. Asking what a barrel exports needs the namespace; there is no other way to read it. |

The `**/*.test.ts` override also covers `**/*-fixture.ts`, and
`pnpm check:boundaries` exempts both. A fixture is test code: it may reach for a
plugin, and it may import more than ten things to wire one.

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
