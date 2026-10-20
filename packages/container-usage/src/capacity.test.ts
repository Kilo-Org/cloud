import type { WorkerDb } from '@kilocode/db/client';
import { container_usage_interval, kilocode_users, organizations } from '@kilocode/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { lockContainerCapacity, readContainerCapacity } from './capacity';
import type { ContainerCapacityRequest } from './concurrency';

const dialect = new PgDialect();
const request: ContainerCapacityRequest = {
  subject: { type: 'org', id: 'org-1' },
  actor: { type: 'user', id: 'oauth/github:actor-1' },
  instanceId: 'sbx-1',
  checkpoint: 'sandbox-start',
};

function reader(results: unknown[][]) {
  const queries: { table: unknown; predicate: SQL }[] = [];
  const select = vi.fn();
  select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async (predicate: SQL) => {
        queries.push({ table, predicate });
        return results.shift() ?? [];
      },
    }),
  }));
  return { db: { select } satisfies Pick<WorkerDb, 'select'>, queries };
}

describe('readContainerCapacity', () => {
  it('uses the billing account balance and counts the human actor across organizations', async () => {
    const { db, queries } = reader([[{ balance: 2_999_999 }], [{ live: 3 }], [{ live: 49 }]]);
    await expect(readContainerCapacity(db, request)).resolves.toEqual([
      { subject: { type: 'user', id: request.actor.id }, live: 3, limit: 3 },
      { subject: request.subject, live: 49, limit: 50 },
    ]);

    expect(queries.map(query => query.table)).toEqual([
      organizations,
      container_usage_interval,
      container_usage_interval,
    ]);
    const actor = dialect.sqlToQuery(queries[1].predicate);
    expect(actor.sql).toContain('"actor_type"');
    expect(actor.sql).toContain('"actor_id"');
    expect(actor.sql).not.toContain('"subject_id"');
    expect(actor.params).toContain(request.actor.id);
    expect(actor.params).not.toContain(request.subject.id);
    const organization = dialect.sqlToQuery(queries[2].predicate);
    expect(organization.sql).toContain('"subject_type"');
    expect(organization.sql).toContain('"subject_id"');
    expect(organization.params).toContain(request.subject.id);
  });

  it('counts only recent, open Cloud Agent intervals, excluding this instance and Code Reviewer', async () => {
    const { db, queries } = reader([[{ balance: 3_000_000 }], [{ live: 19 }]]);
    const personalRequest = {
      ...request,
      subject: { type: 'user' as const, id: request.actor.id },
    };
    await expect(readContainerCapacity(db, personalRequest)).resolves.toEqual([
      { subject: personalRequest.subject, live: 19, limit: 20 },
    ]);
    expect(queries[0].table).toBe(kilocode_users);
    const query = dialect.sqlToQuery(queries[1].predicate);
    expect(query.sql).toContain('"last_seen_at" > now() - interval \'11 minutes\'');
    expect(query.sql).toContain('"status" =');
    expect(query.sql).toContain('"service" like');
    expect(query.sql).toContain('"service" not like');
    expect(query.sql).toContain('"instance_id" not like');
    expect(query.sql).toContain(
      "coalesce(\"container_usage_interval\".\"metadata\"->>'origin', '') <> 'code-review'"
    );
    expect(query.sql).toContain('"instance_id" <>');
    expect(query.params).toEqual([
      'user',
      request.actor.id,
      'open',
      'cloud-agent-next-%',
      '%code-review%',
      'crv-%',
      request.instanceId,
    ]);
  });

  it('checks bots only against their billing subject without reading a balance', async () => {
    const { db, queries } = reader([[{ live: 50 }]]);
    await expect(
      readContainerCapacity(db, { ...request, actor: { type: 'bot', id: 'bot-1' } })
    ).resolves.toEqual([{ subject: request.subject, live: 50, limit: 50 }]);
    expect(queries).toHaveLength(1);
    expect(queries[0].table).toBe(container_usage_interval);
  });

  it('treats a missing balance row as low balance', async () => {
    const { db } = reader([[], [{ live: 0 }], [{ live: 0 }]]);
    expect((await readContainerCapacity(db, request))[0].limit).toBe(3);
  });
});

describe('lockContainerCapacity', () => {
  async function lockQueries(input: ContainerCapacityRequest) {
    const execute = vi.fn();
    const queries: SQL[] = [];
    execute.mockImplementation(async (query: SQL) => {
      queries.push(query);
    });
    await lockContainerCapacity({ execute }, input);
    return queries.map(query => dialect.sqlToQuery(query));
  }

  it('locks typed string scopes in a stable total order without UUID casts', async () => {
    const queries = await lockQueries(request);
    expect(queries.map(query => query.params[0])).toEqual([
      'container-capacity:org:org-1',
      'container-capacity:user:oauth/github:actor-1',
    ]);
    for (const query of queries) {
      expect(query.sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
      expect(query.sql).not.toContain('::uuid');
    }
  });

  it('shares actor locks across organizations and organization locks with bots', async () => {
    const human = await lockQueries(request);
    const otherOrg = await lockQueries({ ...request, subject: { type: 'org', id: 'org-2' } });
    const bot = await lockQueries({ ...request, actor: { type: 'bot', id: 'bot-1' } });
    expect(otherOrg[1].params).toEqual(human[1].params);
    expect(bot).toHaveLength(1);
    expect(bot[0].params).toEqual(human[0].params);
  });

  it('acquires each scope lock in a separate awaited statement', async () => {
    const gate = Promise.withResolvers<void>();
    const execute = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
    const locking = lockContainerCapacity({ execute }, request);
    expect(execute).toHaveBeenCalledOnce();
    gate.resolve();
    await locking;
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('shares personal-subject bot locks with the corresponding human actor', async () => {
    const subject = { type: 'user' as const, id: request.actor.id };
    const human = await lockQueries({ ...request, subject });
    const bot = await lockQueries({ ...request, subject, actor: { type: 'bot', id: 'bot-1' } });
    expect(bot).toEqual(human);
  });
});
