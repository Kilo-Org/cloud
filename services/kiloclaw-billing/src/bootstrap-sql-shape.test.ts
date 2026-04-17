import { describe, expect, it } from 'vitest';
import { isNotNull } from 'drizzle-orm';
import { getWorkerDb, kiloclaw_subscriptions } from '@kilocode/db';

describe('insertSubscriptionIdempotent SQL shape', () => {
  it('emits ON CONFLICT with the IS NOT NULL predicate so Postgres infers the partial unique index', () => {
    // Real connection string not needed; `.toSQL()` compiles without a server.
    const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');

    const query = db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: 'u1',
        instance_id: '00000000-0000-4000-8000-000000000001',
        plan: 'trial',
        status: 'trialing',
      })
      .onConflictDoNothing({
        target: kiloclaw_subscriptions.instance_id,
        where: isNotNull(kiloclaw_subscriptions.instance_id),
      })
      .toSQL();

    // Partial-index arbiter inference requires the predicate to be restated on
    // the ON CONFLICT clause; without it, PG raises
    // "there is no unique or exclusion constraint matching the ON CONFLICT specification".
    // Drizzle qualifies the predicate column with the table name; that form is
    // accepted by Postgres and correctly infers UQ_kiloclaw_subscriptions_instance.
    expect(query.sql).toMatch(
      /on conflict\s*\(\s*"instance_id"\s*\)\s*where\s+"kiloclaw_subscriptions"\."instance_id"\s+is not null\s+do nothing/i
    );
  });
});
