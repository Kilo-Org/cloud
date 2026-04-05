# Cloudflare DB Proxy

A database proxy service that provides per-app SQLite databases using Cloudflare Durable Objects with REST API access.

## Quick Start

### 1. Setup

```bash
# Install and start dev server
pnpm install && pnpm run dev
# Service runs on http://localhost:8787
```

Create `.dev.vars`:

```env
DB_PROXY_ADMIN_TOKEN=your-admin-token-here
```

### 2. Provision an App

```bash
curl -X POST http://localhost:8787/admin/apps/my-app/provision \
  -H "Authorization: Bearer your-admin-token-here"
```

Response includes `dbToken` - save this for database access.

### 3. Query from Your App

```bash
curl -X POST http://localhost:8787/api/my-app/query \
  -H "Authorization: Bearer <dbToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT * FROM users WHERE email = ?",
    "params": ["alice@example.com"],
    "method": "all"
  }'
```

## Using with Drizzle ORM

### Setup

```bash
npm install drizzle-orm
npm install -D drizzle-kit
```

**Define Schema** (`src/db/schema.ts`):

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at'),
});
```

**Create Client** (`src/db/client.ts`):

```typescript
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';

async function proxyQuery(sql: string, params: unknown[], method: string) {
  const response = await fetch('http://localhost:8787/api/my-app/query', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer YOUR_RUNTIME_TOKEN',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params, method }),
  });
  if (!response.ok) throw new Error((await response.json()).error?.message);
  return response.json();
}

export const db = drizzle(
  async (sql, params, method) => {
    const result = await proxyQuery(sql, params, method);
    return { rows: result.rows };
  },
  { schema }
);
```

**Usage**:

```typescript
import { db } from './db/client';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';

await db.insert(users).values({ name: 'Alice', email: 'alice@example.com' });
const allUsers = await db.select().from(users);
const alice = await db.select().from(users).where(eq(users.email, 'alice@example.com'));
```

### Migrations

**Generate migrations**:

```bash
# Create drizzle.config.ts first
npx drizzle-kit generate
```

**Run migrations** (`db/migrate.ts`):

```typescript
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';

async function batchQuery(queries: { sql: string; params: unknown[]; method: string }[]) {
  const response = await fetch(`${process.env.DB_URL}/batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ queries }),
  });
  if (!response.ok) throw new Error(`Migration failed: ${await response.text()}`);
  return response.json();
}

const db = drizzle(async (sql, params, method) => {
  const result = await batchQuery([{ sql, params: params as unknown[], method }]);
  return { rows: result.results[0].rows };
});

await migrate(db, { migrationsFolder: './drizzle/migrations' });
```

Run: `DB_URL=http://localhost:8787/api/my-app DB_TOKEN=<token> bun run db/migrate.ts`

## Batch Queries

Execute multiple queries in a transaction:

```typescript
await fetch('http://localhost:8787/api/my-app/batch', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <token>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    queries: [
      {
        sql: 'INSERT INTO users (name, email) VALUES (?, ?)',
        params: ['Alice', 'alice@example.com'],
        method: 'run',
      },
      { sql: 'SELECT COUNT(*) FROM users', params: [], method: 'all' },
    ],
  }),
});
```
