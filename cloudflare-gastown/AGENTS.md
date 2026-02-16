# Conventions

## File naming

- Add a suffix matching the module type, e.g. `agents.table.ts`, `gastown.worker.ts`.
- Modules that predominantly export a class should be named after that class, e.g. `AgentIdentity.do.ts` for `AgentIdentityDO`.

## Durable Objects

- Each DO module must export a `get{ClassName}Stub` helper function (e.g. `getRigDOStub`) that centralizes how that DO namespace creates instances. Callers should use this helper instead of accessing the namespace binding directly.

## SQL queries

- Use the type-safe `query()` helper from `util/query.util.ts` for all static SQL queries. Fall back to `sql.exec()` only for dynamically constructed queries.
- Prefix SQL template strings with `/* sql */` for syntax highlighting and to signal intent, e.g. `query(this.sql, /* sql */ \`SELECT ...\`, [...])`.
- Format queries for human readability: use multi-line strings with one clause per line (`SELECT`, `FROM`, `WHERE`, `SET`, etc.).
