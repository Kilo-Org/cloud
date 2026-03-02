# Maintainability

- Prefer TS "type" to TS "interface"

- KISS: Be wary of over-abstracting code. Do report and ask about violations of DRY, but don't prematurely generalize.
- If trivial, avoid TS classes; use e.g. closures instead
- STRONGLY AVOID coding patterns that cannot be statically checked:
  - AVOID typescript's "as" operator
  - AVOID typescript's null-forgiving "!"
  - INSTEAD TRY where possible typescript's "satisfies", or leverage flow-sensitive typing.

- Prefer clear NAMES (for e.g. variables, functions and tests) over COMMENTS.
- ONLY add comments about things that are NOT OBVIOUS in context.
- Keep comments concise.
- DO update or remove comments that become outdated or unnecessary during your edits.
- REMOVE comments that aren't helpful to a future maintainer.
- NEVER automatically convert between snake_case and PascalCase or camelCase just to look conventional. If some external API has symbols in some unusual style, try to represent them exactly, so we can string-search for them with plain regexes. In general, respect form over function: when in conflict, prefer simple, non-clever code over code that merely looks nice.
- AVOID mocks; they make tests complex and brittle, assert on the result instead or check the db to observe
  a side effect. Where necessary refactor a dependency that really can't be tested indirectly into an explicit argument instead, and then pass a fake implementation if needed.
- Keep functions simple: if an argument is merely used to splat in a bunch of options in a return value an the caller can do that equally well, KISS and don't add an argument. Every function argument has a small cost; add them only where they meaningfully simplify the caller somehow.

# Durable Object SQLite

All Durable Object SQLite code uses `drizzle-orm/durable-sqlite`. Use Drizzle's query builder API for all queries. See `docs/do-sqlite-drizzle.md` for conventions.
