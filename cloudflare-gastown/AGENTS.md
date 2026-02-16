# Conventions

## File naming

- Add a suffix matching the module type, e.g. `agents.table.ts`, `gastown.worker.ts`.
- Modules that predominantly export a class should be named after that class, e.g. `AgentIdentity.do.ts` for `AgentIdentityDO`.

## Durable Objects

- Each DO module must export a `get{ClassName}Stub` helper function (e.g. `getRigDOStub`) that centralizes how that DO namespace creates instances. Callers should use this helper instead of accessing the namespace binding directly.

## SQL queries

- Use the type-safe `query()` helper from `util/query.util.ts` for all SQL queries.
- Prefix SQL template strings with `/* sql */` for syntax highlighting and to signal intent, e.g. `query(this.sql, /* sql */ \`SELECT ...\`, [...])`.
- Format queries for human readability: use multi-line strings with one clause per line (`SELECT`, `FROM`, `WHERE`, `SET`, etc.).
- Reference tables and columns via the table interpolator objects exported from `db/tables/*.table.ts` (created with `getTableFromZodSchema` from `util/table.ts`). Never use raw table/column name strings in queries.
- Prefer static queries over dynamically constructed ones. Move conditional logic into the query itself using SQL constructs like `COALESCE`, `CASE`, `NULLIF`, or `WHERE (? IS NULL OR col = ?)` patterns so the full query is always visible as a single readable string.
