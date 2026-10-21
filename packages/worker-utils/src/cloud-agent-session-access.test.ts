import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { queryAccessibleKiloSession } from './cloud-agent-session-access.js';

function createCapturingDb() {
  const joins: { table: unknown; condition: unknown }[] = [];
  let whereCondition: unknown;

  const chain = {
    from: vi.fn((): unknown => chain),
    leftJoin: vi.fn((table: unknown, condition: unknown): unknown => {
      joins.push({ table, condition });
      return chain;
    }),
    where: vi.fn((condition: unknown): unknown => {
      whereCondition = condition;
      return chain;
    }),
    limit: vi.fn(async () => []),
  };

  return {
    db: { select: vi.fn(() => chain) },
    chain,
    joins,
    get whereCondition() {
      return whereCondition;
    },
  };
}

describe('queryAccessibleKiloSession', () => {
  it('honours parent-organization inheritance in the session read predicate', async () => {
    const captured = createCapturingDb();

    await expect(
      queryAccessibleKiloSession(captured.db as never, {
        kiloUserId: 'usr_1',
        kiloSessionId: 'ses_1',
      })
    ).resolves.toBeNull();

    // Direct membership, live target organization, live parent organization,
    // and the permitted parent-role membership are each joined.
    expect(captured.joins).toHaveLength(4);
    expect(captured.chain.limit).toHaveBeenCalledWith(1);

    const dialect = new PgDialect();
    const generated = dialect.sqlToQuery(captured.whereCondition as never).sql;
    expect(generated).toContain('organization_memberships');
    expect(generated).toContain('"parent_organizations"."deleted_at"');
    expect(generated).toContain('"parent_organization_memberships"."id"');

    const joinSql = captured.joins
      .map(join => dialect.sqlToQuery(join.condition as never).sql)
      .join(' ');
    expect(joinSql).toContain('"parent_organization_memberships"."kilo_user_id"');
    expect(joinSql).toContain('"parent_organization_memberships"."role"');
    expect(joinSql).toContain('"parent_organizations"."deleted_at"');
  });
});
