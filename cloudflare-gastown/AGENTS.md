# Conventions

## File naming

- Add a suffix matching the module type, e.g. `agents.table.ts`, `gastown.worker.ts`.
- Modules that predominantly export a class should be named after that class, e.g. `AgentIdentity.do.ts` for `AgentIdentityDO`.

## Durable Objects

- Each DO module must export a `get{ClassName}Stub` helper function (e.g. `getRigDOStub`) that centralizes how that DO namespace creates instances. Callers should use this helper instead of accessing the namespace binding directly.

## IO boundaries

- Always validate data at IO boundaries (HTTP responses, JSON.parse results, SSE event payloads, subprocess output) with Zod schemas. Return `unknown` from raw fetch/parse helpers and `.parse()` in the caller.
- Never use `as` to cast IO data. If the shape is known, define a Zod schema; if not, use `.passthrough()` or a catch-all schema.

## Column naming

- Never name a primary key column just `id`. Encode the entity in the column name, e.g. `bead_id`, `bead_event_id`, `rig_id`. This avoids ambiguity in joins and makes grep-based navigation reliable.

## SQL queries

- Use the type-safe `query()` helper from `util/query.util.ts` for all SQL queries.
- Prefix SQL template strings with `/* sql */` for syntax highlighting and to signal intent, e.g. `query(this.sql, /* sql */ \`SELECT ...\`, [...])`.
- Format queries for human readability: use multi-line strings with one clause per line (`SELECT`, `FROM`, `WHERE`, `SET`, etc.).
- Reference tables and columns via the table interpolator objects exported from `db/tables/*.table.ts` (created with `getTableFromZodSchema` from `util/table.ts`). Never use raw table/column name strings in queries.
- Prefer static queries over dynamically constructed ones. Move conditional logic into the query itself using SQL constructs like `COALESCE`, `CASE`, `NULLIF`, or `WHERE (? IS NULL OR col = ?)` patterns so the full query is always visible as a single readable string.
- Validate/parse query results with the Zod `Record` schemas defined in the corresponding `db/tables/*.table.ts` module. For an array of rows use the `.array()` modifier, e.g. `AgentRecord.array().parse(rows)`.
- When a column has a SQL `CHECK` constraint that restricts it to a set of values (i.e. an enum), mirror that in the Record schema using `z.enum()` rather than `z.string()`, e.g. `role: z.enum(['polecat', 'refinery', 'mayor', 'witness'])`.

## HTTP routes

- **Do not use Hono sub-app mounting** (e.g. `app.route('/prefix', subApp)`). Define all routes in the main worker entry point (e.g. `gastown.worker.ts`) so a human can scan one file and immediately see every route the app exposes.
- Move handler logic into `handlers/*.handler.ts` modules. Each module owns routes for a logical domain. Name the file after the domain, e.g. `handlers/rig-agents.handler.ts` for `/api/rigs/:rigId/agents/*` routes.
- Each handler function takes two arguments:
  1. The Hono `Context` object (typed as the app's `HonoContext` / `GastownEnv`).
  2. A plain object containing the route params parsed from the path, e.g. `{ rigId: string }` or `{ rigId: string; beadId: string }`.

  This keeps the handler's contract explicit and testable, while the route definition in the entry point is the single source of truth for path → param shape.

  ```ts
  // gastown.worker.ts — route definition
  app.post('/api/rigs/:rigId/agents', c => handleRegisterAgent(c, c.req.param()));

  // handlers/rig-agents.handler.ts — handler implementation
  export async function handleRegisterAgent(c: Context<GastownEnv>, params: { rigId: string }) {
    // Zod validation lives in the handler, not as route middleware
    const parsed = RegisterAgentBody.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid request body', issues: parsed.error.issues },
        400
      );
    }
    const rig = getRigDOStub(c.env, params.rigId);
    const agent = await rig.registerAgent(parsed.data);
    return c.json(resSuccess(agent), 201);
  }
  ```
