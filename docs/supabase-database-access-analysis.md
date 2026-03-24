# Supabase / PostgreSQL Access Pattern Analysis

Comprehensive audit of how this codebase interacts with Supabase-hosted PostgreSQL,
covering RLS, data access patterns, and key management.

## 1. Row-Level Security (RLS)

### Database-Level RLS: Not Used

**No RLS policies exist in this codebase.** Across all 59 PostgreSQL migration files
(`packages/db/src/migrations/0000_baseline.sql` through `0058_oauth_username_and_discord_verifications.sql`)
and 7 Durable Object SQLite migration sets, there are zero instances of:

- `CREATE POLICY`
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- `DROP POLICY`

The Drizzle ORM snapshot metadata (`packages/db/src/migrations/meta/*.json`) explicitly
marks every table with `"isRLSEnabled": false`.

### Access Control: Enforced Entirely in Application Code

All data access scoping is implemented through a layered application-level architecture:

#### Layer 1: Authentication Gate

Every request must pass through `getUserFromAuth()` (`src/lib/user.server.ts:701-761`),
which validates either a JWT bearer token or a NextAuth session. The authenticated `User`
object is injected into the tRPC context via `createTRPCContext()` (`src/lib/trpc/init.ts:15-27`).

```ts
// src/lib/trpc/init.ts:15-27
export const createTRPCContext = async (): Promise<TRPCContext> => {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not authenticated - no user to set on context',
    });
  }
  return { user };
};
```

#### Layer 2: Procedure-Level Authorization

Four tRPC procedure tiers gate access before any query runs:

| Procedure | File | Purpose |
|-----------|------|---------|
| `baseProcedure` | `src/lib/trpc/init.ts:80` | Requires authenticated user |
| `adminProcedure` | `src/lib/trpc/init.ts:83-91` | Requires `ctx.user.is_admin` |
| `organizationMemberProcedure` | `src/routers/organizations/utils.ts:101-121` | Verifies org membership |
| `organizationOwnerProcedure` | `src/routers/organizations/utils.ts:124-129` | Verifies owner/billing_manager role |

#### Layer 3: Query-Level WHERE Filtering

Every database query that returns user-scoped data includes explicit WHERE clauses
filtering by the authenticated user's ID. This pattern is consistent across all routers.

**User-scoped queries** (most common pattern):

```ts
// src/routers/security-audit-log-router.ts — all queries start with this
.where(eq(security_audit_log.owned_by_user_id, ctx.user.id))

// src/routers/user-router.ts:144 — credit transactions
.where(eq(credit_transactions.kilo_user_id, ctx.user.id))

// src/routers/cli-sessions-router.ts — session ownership
.where(and(
  eq(cliSessions.session_id, sessionId),
  eq(cliSessions.kilo_user_id, userId)
))
```

**Organization-scoped queries** use `ensureOrganizationAccess()` (`src/routers/organizations/utils.ts:15-48`)
which queries `organization_memberships` with both user ID and org ID:

```ts
// src/routers/organizations/utils.ts:24-32
const rows = await db
  .select({ role: organization_memberships.role })
  .from(organization_memberships)
  .where(and(
    eq(organization_memberships.kilo_user_id, ctx.user.id),
    eq(organization_memberships.organization_id, organizationId)
  ));
```

**Dual user/org scope** — resources that can be owned by either a user or organization
use conditional WHERE clauses:

```ts
// src/routers/byok-router.ts:116-120
.where(
  organizationId
    ? eq(byok_api_keys.organization_id, organizationId)
    : eq(byok_api_keys.kilo_user_id, ctx.user.id)
)
```

#### Layer 4: Post-Fetch Ownership Verification

For resources with complex ownership (user OR organization), a fetch-then-verify pattern
is used in code reviews, auto-triage, auto-fix, BYOK, and security findings:

```ts
// src/routers/code-reviews/code-reviews-router.ts:303-321
if (review.owned_by_organization_id) {
  await ensureOrganizationAccess(ctx, review.owned_by_organization_id);
} else if (review.owned_by_user_id) {
  if (review.owned_by_user_id !== ctx.user.id) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
}
```

### Implications

Without database-level RLS, a bug in any application-layer filter (e.g., a missing
WHERE clause) could expose data across tenants. The current approach is consistent and
well-structured, but the entire access control surface area is in application code
rather than being enforced as a database-level invariant.

---

## 2. Supabase API vs Direct SQL

### Supabase Client SDK: Not Used

The `@supabase/supabase-js` package is **not a dependency** of this project. There are:

- Zero imports of `@supabase/supabase-js`, `@supabase/ssr`, or `@supabase/auth-helpers`
- Zero calls to `createClient()`, `createBrowserClient()`, or `createServerClient()`
- Zero PostgREST-style queries (`supabase.from()`, `supabase.rpc()`, `supabase.auth.*`)
- No `supabase/` directory or `supabase/config.toml`

Supabase is used **exclusively as a managed PostgreSQL host**. The only evidence of a
prior Supabase SDK dependency is in a historical test fixture
(`src/tests/req_sample/anthropic-claude37.log.req.json`), and stale ignore patterns
in `.oxlintrc.json`, `eslint.fallback.config.mjs`, and `knip.ts` that reference
a nonexistent `supabase/functions/` directory.

### Actual Database Access: Drizzle ORM + node-postgres (`pg`)

All database access uses **Drizzle ORM** with the **`pg` (node-postgres)** driver.

#### Dependencies

| Package | Version | Location |
|---------|---------|----------|
| `drizzle-orm` | `^0.45.1` | `packages/db`, root `package.json` |
| `pg` | `^8.20.0` | `packages/db` |
| `drizzle-kit` | `^0.31.9` | `packages/db` (dev) |

#### Connection Architecture

| Connection | Config File | Driver | Purpose |
|------------|-------------|--------|---------|
| Primary pool | `src/lib/drizzle.ts:80` | `pg.Pool` → `drizzle()` | Frankfurt-primary writes + reads |
| Read replica pool | `src/lib/drizzle.ts` (via `getReplicaUrl()`) | `pg.Pool` → `drizzle()` | Region-aware replica reads (US/EU) |
| Worker Hyperdrive | `packages/db/src/client.ts:44-47` | `pg.Pool(max:1)` → `drizzle()` | Cloudflare Workers via Hyperdrive |
| Durable Object SQLite | Per-worker `src/db/sqlite-schema.ts` | `drizzle-orm/durable-sqlite` | Edge state in 7 CF Workers |
| Scripts | `src/lib/drizzle.ts:28-33` | `pg.Pool` → `drizzle()` | Isolated script connection (`POSTGRES_SCRIPT_URL`) |
| Tests | `src/tests/setup/workerSetup.ts` | `pg.Client` (DDL) + `drizzle()` | Per-worker test databases |

#### Query Patterns

The vast majority of queries use Drizzle's type-safe query builder:

```ts
// Typical select
db.select().from(kilocode_users).where(eq(kilocode_users.id, userId))

// Typical insert
db.insert(credit_transactions).values({ ... }).returning()

// Typical update
db.update(kilocode_users).set({ ... }).where(eq(kilocode_users.id, userId))
```

Raw SQL via Drizzle's `sql` tagged template is used sparingly in:

- Data migration scripts (`src/scripts/`) for complex CTEs and batch operations
- `src/routers/unified-sessions-router.ts` for UNION queries across session tables
- `src/lib/drizzle.ts` for `cleanupDbForTest()` (TRUNCATE ALL)
- Monitoring scripts (`src/scripts/monitor-pg-activity.ts`)

Direct `client.query()` (raw node-postgres) is limited to:

- Test setup DDL: `DROP DATABASE` / `CREATE DATABASE` (`src/tests/setup/workerSetup.ts`)
- A few legacy scripts (`src/scripts/test-sonnet-46-review-promo.ts`)

#### Schema Definition

The primary schema is defined in `packages/db/src/schema.ts` (3,593 lines) using
Drizzle's `pgTable` builder. Migrations are generated by `drizzle-kit` and stored
in `packages/db/src/migrations/` (59 SQL files).

---

## 3. Supabase Key Usage

### Anon Key: Not Present

There are zero references to `SUPABASE_ANON_KEY`, `SUPABASE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
or any Supabase anon key variant anywhere in the codebase — not in source code, environment
files, or configuration.

### Service Role Key: Not Present

There are zero references to `SUPABASE_SERVICE_ROLE_KEY` or any service role key variant.

### SUPABASE_URL: Not Present

There are no `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` environment variables.

### How the Database Is Actually Connected

The connection uses standard PostgreSQL connection strings, not Supabase-specific keys:

| Env Variable | Purpose | Used In |
|-------------|---------|---------|
| `POSTGRES_URL` | Primary connection string | `src/lib/drizzle.ts:16` |
| `POSTGRES_SCRIPT_URL` | Isolated script connection | `src/lib/drizzle.ts:32` |
| `POSTGRES_REPLICA_US_URL` | US read replica | `src/lib/drizzle.ts:56` |
| `POSTGRES_REPLICA_EU_URL` | EU read replica | `src/lib/drizzle.ts:59` |
| `POSTGRES_CONNECT_TIMEOUT` | Pool connection timeout | `src/lib/drizzle.ts:76` |
| `POSTGRES_MAX_QUERY_TIME` | Query statement timeout | `src/lib/drizzle.ts` |
| `DATABASE_CA` | SSL CA certificate | `packages/db/src/database-url.ts` |

No Supabase keys are exposed in client-side code. The only `NEXT_PUBLIC_*` variables
are for PostHog, Sentry, Stytch, Stripe, and Turnstile — none are Supabase-related.

### Client-Side Exposure Risk: None

Since the Supabase client SDK is not used and no Supabase keys exist in the codebase,
there is no risk of anon key or service role key leakage in client-side bundles.

---

## Summary

| Aspect | Finding |
|--------|---------|
| **RLS** | Not used. `"isRLSEnabled": false` on all tables. Zero SQL policies. |
| **Access control** | Application-level only: auth middleware → tRPC procedures → WHERE clauses with `ctx.user.id` / org membership checks. |
| **Supabase SDK** | Not used. No `@supabase/supabase-js` dependency. Historical traces only. |
| **Database driver** | `drizzle-orm` + `pg` (node-postgres) for PostgreSQL; `drizzle-orm/durable-sqlite` for CF DO edge state. |
| **Supabase keys** | None present. Connection uses standard `POSTGRES_URL` connection strings. |
| **Client exposure** | No Supabase keys in client-side code. No risk of key leakage. |
| **Supabase role** | Managed PostgreSQL hosting provider only (connection pooling, replicas). |
