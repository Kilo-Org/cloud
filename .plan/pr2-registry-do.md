# PR 2: Registry DO + Lazy Migration — Implementation Plan

## Goal

Add the `KiloClawRegistry` DO (SQLite-backed via Drizzle). Wire provision and proxy flows through it. Enable lazy migration of legacy instances. Update `ensureActiveInstance` to support instance-keyed sandboxId derivation for new instances.

## Design Decisions

### Drizzle (not gastown raw SQL)

The plan originally referenced "gastown Zod/table-interpolator/`query()` conventions". The project-wide coding-style rule mandates `drizzle-orm/durable-sqlite`. Seven other workers use Drizzle. Following the `cloudflare-o11y/AlertConfigDO` pattern:

- Schema in `kiloclaw/src/db/sqlite-schema.ts`
- Config in `kiloclaw/drizzle.config.ts`
- Migrations generated via `pnpm drizzle-kit generate` in `kiloclaw/drizzle/`
- Constructor: `drizzle(ctx.storage, { logger: false })` + `migrate(db, migrations)` in `blockConcurrencyWhile`

Add `drizzle-kit` as a devDependency in `kiloclaw/package.json`.

### Registry ownerKey pattern

Every public method on the Registry DO accepts `ownerKey` as its first parameter. The DO stores it in `ctx.storage.put('owner_key', key)` on the first call and validates consistency on subsequent calls. No separate `setOwnerKey` RPC. No wrapper function needed — callers create the stub and call methods directly, passing the registry key they used for `idFromName()`.

This is the cleanest approach:

- No extra DO roundtrip for initialization
- Self-documenting — every call site shows which registry it's addressing
- No risk of forgetting initialization — ownerKey is atomically available in the method that needs it

### Registry reads Postgres directly

The Registry DO reads from Postgres via HYPERDRIVE for lazy migration (same pattern as the Instance DO). Self-contained — no caller-side Postgres coordination needed.

### Lazy migration fallback — throw on orphaned DO

If Postgres has no active row AND the legacy Instance DO has state, the Registry DO throws an error. This edge case only occurs via manual DB deletion. Not worth the complexity of repair logic or violating the "Next.js is sole Postgres writer" invariant.

### `ensureActiveInstance` sandboxId derivation

For org instances (and future multi-instance), generate UUID client-side (`crypto.randomUUID()`), derive sandboxId from it via `sandboxIdFromInstanceId()`, insert both in one operation. Legacy personal flow unchanged (sandboxId from userId).

### restoreFromPostgres update

The DO uses its stored `sandboxId` (always available for provisioned DOs) as the primary lookup key via `getInstanceBySandboxId`. Falls back to `getActiveInstance(db, userId)` for legacy DOs without a sandboxId in state.

---

## File-by-File Changes

### Worker Files

#### 1. `kiloclaw/src/db/sqlite-schema.ts` — NEW

Registry instances table for the DO SQLite database:

```typescript
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const registryInstances = sqliteTable('instances', {
  instance_id: text('instance_id').primaryKey(),
  do_key: text('do_key').notNull(),
  assigned_user_id: text('assigned_user_id').notNull(),
  created_at: text('created_at').notNull(),
  destroyed_at: text('destroyed_at'),
});
```

#### 2. `kiloclaw/drizzle.config.ts` — NEW

```typescript
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  out: './drizzle',
  schema: './src/db/sqlite-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
});
```

#### 3. `kiloclaw/drizzle/` — NEW (generated)

Run `pnpm drizzle-kit generate` from `kiloclaw/` directory.

#### 4. `kiloclaw/package.json` — EDIT

Add `drizzle-kit` to devDependencies.

#### 5. `kiloclaw/wrangler.jsonc` — EDIT

Add DO binding + migration:

- Binding: `{ "name": "KILOCLAW_REGISTRY", "class_name": "KiloClawRegistry" }`
- Migration: `{ "tag": "v6", "new_sqlite_classes": ["KiloClawRegistry"] }`

#### 6. `kiloclaw/src/types.ts` — EDIT

Add `KILOCLAW_REGISTRY: DurableObjectNamespace<KiloClawRegistry>` to `KiloClawEnv`.

#### 7. `kiloclaw/src/durable-objects/kiloclaw-registry.ts` — NEW

Registry DO class using Drizzle ORM with DO SQLite.

**Constructor**: `drizzle(ctx.storage, { logger: false })` + `migrate(db, migrations)` in `blockConcurrencyWhile`. Loads `ownerKey` from `ctx.storage.get('owner_key')` in `blockConcurrencyWhile`.

**Internal state**:

- `ownerKey: string | null` — persisted via `ctx.storage.put('owner_key', key)`, loaded in constructor
- `migrated: boolean` — persisted via `ctx.storage.put('migrated', true)`, loaded in constructor

**Methods** (all accept `ownerKey: string` as first param):

- `listInstances(ownerKey): RegistryEntry[]` — returns all active entries (`destroyed_at IS NULL`). Triggers lazy migration on first call if `!this.migrated`. Stores ownerKey on first call.

- `createInstance(ownerKey, assignedUserId, instanceId, doKey): void` — inserts a new entry. Stores ownerKey on first call.

- `destroyInstance(ownerKey, instanceId): void` — soft-deletes (sets `destroyed_at`).

- `resolveDoKey(ownerKey, instanceId): string | null` — returns the `do_key` for a given instanceId.

- `findInstancesForUser(ownerKey, userId): RegistryEntry[]` — returns all active entries for a specific `assigned_user_id`.

**Lazy migration** (user registries only — ownerKey starts with `user:`):

1. Parse userId from ownerKey (`user:{userId}` → userId).
2. Read from Postgres via Hyperdrive: `getActiveInstance(db, userId)` → `{ id, sandboxId }`.
3. If row exists: INSERT registry entry `{ instance_id: row.id, do_key: userId, assigned_user_id: userId, created_at: now }`.
4. If no Postgres row: probe legacy Instance DO at `idFromName(userId).getStatus()`.
   - If DO has state (userId is set): throw error — orphaned DO without Postgres row needs manual investigation.
   - If DO has no state: no legacy instance. Migration complete.
5. If Hyperdrive unavailable: defer migration. Next access retries.
6. On success: persist `migrated = true`.

**Return type**:

```typescript
type RegistryEntry = {
  instanceId: string;
  doKey: string;
  assignedUserId: string;
  createdAt: string;
  destroyedAt: string | null;
};
```

#### 8. `kiloclaw/src/routes/platform.ts` — EDIT

**Provision route** (~line 280-331):

After successful DO provision, create registry entry. The `instanceId` is now always passed from Next.js (the Postgres row UUID):

```typescript
// After withDORetry succeeds (line ~321):
const registryKey = orgId ? `org:${orgId}` : `user:${userId}`;
const registryStub = c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(registryKey));
const doKey = instanceId ?? userId;
await registryStub.createInstance(registryKey, userId, instanceId, doKey);
```

Note: `instanceId` is always present now because Next.js always passes it. The `?? userId` fallback on doKey is for the case where the DO was keyed by userId (legacy personal). For new instances (PR 3+), doKey = instanceId.

**Destroy route** (~line 1068-1088):

Read Instance DO status first to determine registry key, then destroy:

```typescript
// Before calling stub.destroy():
const statusStub = instanceStubFactory(c.env, userId, instanceId)();
const status = await statusStub.getStatus();
const registryKey = status.orgId ? `org:${status.orgId}` : `user:${userId}`;

// After withDORetry succeeds:
if (instanceId) {
  const registryStub = c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(registryKey));
  await registryStub.destroyInstance(registryKey, instanceId);
}
```

#### 9. `kiloclaw/src/index.ts` — EDIT

**Export Registry DO class** alongside existing exports.

**Legacy catch-all `resolveInstance`** (~line 368-383):

Replace direct `idFromName(userId)` with registry lookup:

```typescript
async function resolveInstance(c: Context) {
  const userId = c.get('userId');
  const registryStub = c.env.KILOCLAW_REGISTRY.get(
    c.env.KILOCLAW_REGISTRY.idFromName(`user:${userId}`)
  );
  const entries = await registryStub.listInstances(`user:${userId}`);

  if (entries.length === 0) {
    return null; // No instances — never provisioned or all destroyed
  }

  const entry = entries[0]; // default personal instance
  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(entry.doKey));
  const status = await stub.getStatus();
  // ... existing machineId/flyAppName/status extraction ...
}
```

**`attemptCrashRecovery`** (~line 320-362):

Same pattern — resolve doKey from registry instead of direct `idFromName(userId)`:

```typescript
async function attemptCrashRecovery(c: Context) {
  const userId = c.get('userId');
  const registryStub = c.env.KILOCLAW_REGISTRY.get(
    c.env.KILOCLAW_REGISTRY.idFromName(`user:${userId}`)
  );
  const entries = await registryStub.listInstances(`user:${userId}`);
  if (entries.length === 0) return false;

  const entry = entries[0];
  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(entry.doKey));
  // ... existing crash recovery logic ...
}
```

#### 10. `kiloclaw/src/durable-objects/kiloclaw-instance/postgres.ts` — EDIT

Update `restoreFromPostgres` signature to accept optional lookup hints:

```typescript
export async function restoreFromPostgres(
  env: KiloClawEnv,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  userId: string,
  opts?: { sandboxId?: string | null }
): Promise<void> {
  // ... existing HYPERDRIVE check ...

  const db = getWorkerDb(connectionString);
  const instance = opts?.sandboxId
    ? await getInstanceBySandboxId(db, opts.sandboxId)
    : await getActiveInstance(db, userId);

  if (!instance) {
    doWarn(state, 'No active instance found in Postgres', { userId });
    return;
  }

  // ... rest unchanged ...
}
```

Update the call site in `kiloclaw-instance/index.ts` `_startInner()` (~line 909-913):

```typescript
if (!this.s.userId || !this.s.sandboxId) {
  const restoreUserId = userId ?? this.s.userId;
  if (restoreUserId) {
    await restoreFromPostgres(this.env, this.ctx, this.s, restoreUserId, {
      sandboxId: this.s.sandboxId,
    });
  }
}
```

### Next.js Files

#### 11. `src/lib/kiloclaw/instance-registry.ts` — EDIT

Update `ensureActiveInstance` to support instance-keyed sandboxId derivation for org instances:

```typescript
export async function ensureActiveInstance(
  userId: string,
  opts?: EnsureActiveInstanceOpts
): Promise<ActiveKiloClawInstance> {
  if (opts?.orgId) {
    // Org instance: generate UUID, derive sandboxId from it
    const instanceId = crypto.randomUUID();
    const sandboxId = sandboxIdFromInstanceId(instanceId);

    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: userId,
      sandbox_id: sandboxId,
      organization_id: opts.orgId,
    });

    const [row] = await db
      .select({
        id: kiloclaw_instances.id,
        userId: kiloclaw_instances.user_id,
        sandboxId: kiloclaw_instances.sandbox_id,
        organizationId: kiloclaw_instances.organization_id,
        name: kiloclaw_instances.name,
      })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instanceId))
      .limit(1);

    if (!row) throw new Error('Failed to create org instance row');
    return row;
  }

  // Legacy personal flow — unchanged
  const sandboxId = sandboxIdFromUserId(userId);
  // ... existing insert + select ...
}
```

Add import for `sandboxIdFromInstanceId` from `./sandbox-id`.

#### 12. `src/routers/kiloclaw-router.ts` — EDIT

**`provisionInstance`** (~line 306-360):

Always pass `instanceId` to the internal client:

```typescript
return await client.provision(
  user.id,
  {
    envVars: input.envVars,
    encryptedSecrets,
    channels: buildWorkerChannels(input.channels),
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel: input.kilocodeDefaultModel ?? undefined,
    pinnedImageTag,
  },
  {
    instanceId: instanceRow.id,
  }
);
```

**`destroy` mutation** (~line 624-690):

Pass `instanceId` to the internal client:

```typescript
destroy: baseProcedure.mutation(async ({ ctx }) => {
  const destroyedRow = await markActiveInstanceDestroyed(ctx.user.id);
  const client = new KiloClawInternalClient();
  let result;
  try {
    result = await client.destroy(ctx.user.id, destroyedRow?.id);
  } catch (error) {
    if (destroyedRow) {
      await restoreDestroyedInstance(destroyedRow.id);
    }
    throw error;
  }
  // ... existing post-destroy cleanup ...
}),
```

---

## Deviations from Original Plan

### 1. Drizzle ORM instead of gastown raw SQL

The original plan specified gastown Zod/table-interpolator conventions. Using Drizzle instead per project coding-style rules. Impact: table definitions use `sqliteTable` instead of Zod schemas + `getTableFromZodSchema`. Queries use Drizzle query builder instead of raw SQL with `query()` helper.

### 2. ownerKey as method parameter instead of separate setOwnerKey RPC

The original plan specified a `setOwnerKey()` method + `getOrInitRegistry()` wrapper. Using first-param pattern instead. Every method accepts `ownerKey` as first argument. The DO stores it once and validates on subsequent calls. No wrapper function needed.

### 3. No DO probe on Postgres miss — throw error instead

The original plan called for probing the legacy Instance DO when Postgres has no row, and creating a Postgres row from the DO state. We throw an error instead. This avoids violating the "Next.js is sole Postgres writer" invariant and simplifies the code.

---

## Execution Order

1. `kiloclaw/src/db/sqlite-schema.ts` — create Drizzle table definition
2. `kiloclaw/drizzle.config.ts` — create Drizzle config
3. `kiloclaw/package.json` — add `drizzle-kit` devDependency
4. `pnpm install && pnpm drizzle-kit generate` in `kiloclaw/`
5. `kiloclaw/src/durable-objects/kiloclaw-registry.ts` — create DO class
6. `kiloclaw/wrangler.jsonc` — add binding + migration
7. `kiloclaw/src/types.ts` — add env binding type
8. `kiloclaw/src/index.ts` — export DO, wire legacy catch-all through registry
9. `kiloclaw/src/routes/platform.ts` — registry create/destroy in provision/destroy routes
10. `kiloclaw/src/durable-objects/kiloclaw-instance/postgres.ts` — multi-instance restore
11. `kiloclaw/src/durable-objects/kiloclaw-instance/index.ts` — update `_startInner` call to restoreFromPostgres
12. `src/lib/kiloclaw/instance-registry.ts` — org sandboxId derivation
13. `src/routers/kiloclaw-router.ts` — thread instanceId to worker
14. Tests — new registry DO tests + update existing restore tests
15. `pnpm typecheck && pnpm test && pnpm lint`

## Risks

- **Lazy migration is the critical path**: Must handle Hyperdrive unavailability gracefully (defer, don't crash). Must handle empty DOs (never provisioned) and destroyed DOs correctly.
- **Extra DO hop in proxy path**: The legacy catch-all now makes a registry DO RPC before the instance DO RPC. Sub-millisecond for SQLite queries, but it's a new latency component. Monitor after deploy.
- **Registry/Postgres divergence**: Registry entries without Postgres rows are stale. Postgres rows without registry entries are caught by lazy migration. The "Postgres wins" contract from the original plan applies.
