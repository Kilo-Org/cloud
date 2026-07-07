# Maintainability

- Prefer TS "type" to TS "interface"

- KISS: Be wary of over-abstracting code. Do report and ask about violations of DRY, but don't prematurely generalize.
- If trivial, avoid TS classes; use e.g. closures instead
- STRONGLY AVOID coding patterns that cannot be statically checked:
  - Use `as` casts sparingly, but do not ban them outright. Prefer `satisfies`, discriminated unions, generics, or flow-sensitive narrowing when TypeScript can be made to understand the type naturally.
  - A targeted `as` cast is acceptable when code is at a known boundary where TypeScript has lost information that the surrounding control flow guarantees. For example, inside a platform switch, casting `message` to `Message<SlackEvent>` or `Message<GitHubRawMessage>` is preferable to adding generic `Record<string, unknown>` property helpers just to read known adapter fields.
  - Avoid broad casts that hide real uncertainty, especially `as any`, double casts through `unknown`, or casting external/untrusted data without validation. Use runtime validation when the data shape is genuinely unknown, user-controlled, persisted, or coming from an API contract we do not own.
  - `as` casts are explicitly permitted inside test files (e.g. `*.test.ts`, `*.spec.ts`, files under `__tests__/`, and other test fixtures/helpers) — they are commonly needed for fixture construction, narrowing partial mocks, and exercising error paths. Production code conventions still apply to non-test code imported by tests.
  - AVOID typescript's null-forgiving "!"; prefer explicit checks or flow-sensitive typing.

- Prefer clear NAMES (for e.g. variables, functions and tests) over COMMENTS.
- ONLY add comments about things that are NOT OBVIOUS in context.
- Keep comments concise.
- DO update or remove comments that become outdated or unnecessary during your edits.
- REMOVE comments that aren't helpful to a future maintainer.
- NEVER automatically convert between snake_case and PascalCase or camelCase just to look conventional. If some external API has symbols in some unusual style, try to represent them exactly, so we can string-search for them with plain regexes. In general, respect form over function: when in conflict, prefer simple, non-clever code over code that merely looks nice.
- AVOID mocks; they make tests complex and brittle, assert on the result instead or check the db to observe
  a side effect. Where necessary refactor a dependency that really can't be tested indirectly into an explicit argument instead, and then pass a fake implementation if needed.
- Keep functions simple: if an argument is merely used to splat in a bunch of options in a return value an the caller can do that equally well, KISS and don't add an argument. Every function argument has a small cost; add them only where they meaningfully simplify the caller somehow.
- When the linter flags an unused variable, do NOT just prefix it with `_` to silence the warning. Instead, investigate why it's unused and fix the root cause — remove dead parameters, delete dead code paths, or log/use the value if it was accidentally ignored. The `_` prefix is only appropriate for intentionally unused positional parameters (e.g. `(_req, res)` in middleware signatures).

# Durable Object SQLite

All Durable Object SQLite code uses `drizzle-orm/durable-sqlite`. Use Drizzle's query builder API for all queries. See `docs/do-sqlite-drizzle.md` for conventions.
