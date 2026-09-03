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
   already gives you.
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
- Run `pnpm typecheck && pnpm lint && pnpm test` in this directory before you
  commit.

## The kilo gateway

`POST {baseUrl}/api/gateway/v1/messages` takes the Anthropic Messages body, so
`cache_control` reaches the model.

| Header | Value |
|---|---|
| `authorization` | `Bearer {user token}` |
| `x-kilocode-organizationid` | The organization id. Leave it out for a personal account. |

The route also serves `/chat/completions` and `/responses`, and it accepts the
older `/api/openrouter` prefix. The package uses `/messages` only.

## Decisions

### The session does not write to the store

`appendTurn` is a pure function. It does not touch the `SessionStore` plugin.
Do not make it write through.

- A pure append has no error channel and no requirement, so no caller inherits
  a store failure.
- The runner flushes once per step, so one step is one transaction, not one
  transaction per turn.
- A session runs with no store at all. This is what lets the package run in a
  browser or in a mobile app.

The cost is that a crash drops the turns since the last flush. If that cost
becomes real, the next step is write-behind: `appendTurn` stays pure and pushes
to an Effect `Queue`, and a forked fiber drains it. Do not build the queue
before a crash loses real data.

### A reloaded turn must equal the turn that was written

The prompt prefix is rebuilt from the store. If `load` returns a turn that
differs from the written turn in one byte or in the order, the prefix changes
and the model cache misses. The SQLite plugin must prove the round trip with a
local end-to-end run.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | The public entry point |
| `src/session.ts` | The session and its append-only turns |
| `src/turn.ts` | One turn, shaped as one SQLite row |
| `src/model.ts` | The `ModelClient` plugin point; transport only |
| `src/kilo-gateway.ts` | The kilo gateway plugin |
| `src/kilo-gateway-wire.ts` | The Anthropic Messages body and the reply schema |
| `src/fetch.ts` | The smallest `fetch` the package needs |
| `src/prompt.ts` | The `PromptAssembler` plugin point and the core assembler |
| `src/storage.ts` | The `SessionStore` plugin point; no plugin yet |
| `src/id.ts` | The `IdGenerator` plugin point and the ULID plugin |
| `.oxlintrc.json` | The package lint config; stricter than the root config |
| `tsconfig.json` | The package compiler config; stricter than the root config |

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
| `promise/prefer-await-to-then` | It flags `Promise.resolve`, and it deadlocks with `require-await`. |

`new-cap` stays on with `Tag` and `GenericTag` as exceptions, because
`Context.Tag` is a call, not a constructor.

`isolatedDeclarations` is off. It cannot infer a Zod schema type, and the
package ships its source, so it buys no build time.

`import/group-exports` stays on. Declare a name, then export it in one
`export type { ... }` block and one `export { ... }` block at the end of the
file.
