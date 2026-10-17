import {
  cleanupDbForTest,
  pool,
  db,
  selectReplicaUrl,
  shouldExitOnPoolError,
  sql,
} from '@kilocode/web-shared/lib/drizzle';
import { exa_usage_log, http_ip, http_user_agent } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

describe('drizzle', () => {
  describe('pool', () => {
    it('should have application_name set', async () => {
      const client = await pool.connect();
      const res = await client.query("SELECT current_setting('application_name')");
      expect(res.rows[0].current_setting).toBe('kilocode-web');
      client.release();
    });
  });

  it('should use application name', async () => {
    const res = await db.execute("SELECT current_setting('application_name')");
    expect(res.rows[0].current_setting).toBe('kilocode-web');
  });

  describe('pool error listeners', () => {
    it('attaches a non-exiting error listener in test mode', () => {
      // If no listener is attached, Node treats an 'error' emit as a throw.
      // In test mode, pool.end() during cleanup triggers idle client errors
      // that must not crash the test runner.
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
    });

    it('does not throw on an idle-client error in test mode', () => {
      // The test-mode handler catches errors without exit.
      // Verifying the emit does not throw proves the listener works.
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => pool.emit('error', new Error('idle client disconnect'))).not.toThrow();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('exits on a primary pool error outside test mode', () => {
      // A dead primary pool means the process cannot serve traffic at all.
      expect(shouldExitOnPoolError('primary', 'production')).toBe(true);
    });

    it('does not exit on a replica pool error outside test mode', () => {
      // Regression guard: exiting here escalated a replica-only outage into 107
      // instance terminations on 2026-08-12 while the primary was healthy.
      // The replica is a read-path optimisation with a primary fallback, so a
      // broken replica must degrade reads rather than kill the process.
      expect(shouldExitOnPoolError('replica', 'production')).toBe(false);
    });

    it('never exits in test mode, so pool.end() cleanup cannot kill the runner', () => {
      expect(shouldExitOnPoolError('primary', 'test')).toBe(false);
      expect(shouldExitOnPoolError('replica', 'test')).toBe(false);
    });
  });

  describe('replica selection', () => {
    const primaryUrl = 'postgres://primary';

    it('uses the primary in local development even when replicas are configured', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'development',
          vercelRegion: undefined,
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-replica'],
        })
      ).toBe(primaryUrl);
    });

    it('preserves EU replica selection for regionless non-development processes', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: undefined,
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-replica'],
          random: () => 0,
        })
      ).toBe('postgres://eu-replica');
    });

    it('uses the US replica in a US Vercel region', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'iad1',
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-replica'],
        })
      ).toBe('postgres://us-replica');
    });

    it('selects between EU replicas in an EU Vercel region', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'fra1',
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-1', 'postgres://eu-2'],
          random: () => 0.75,
        })
      ).toBe('postgres://eu-2');
    });

    it('falls back to the primary when the regional replica is unavailable', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'iad1',
          usReplicaUrl: undefined,
          euReplicaUrls: ['postgres://eu-replica'],
        })
      ).toBe(primaryUrl);
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'fra1',
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: [],
        })
      ).toBe(primaryUrl);
    });
  });

  describe('cleanupDbForTest', () => {
    async function publicRelations() {
      const { rows } = await db.execute<{ name: string }>(sql`
        SELECT format('%I', c.relname) AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'migrations'
        ORDER BY c.relname
      `);
      return rows.map(row => row.name);
    }

    async function nonEmptyRelations() {
      const relations = await publicRelations();
      const { rows } = await db.execute<{ name: string; rows: string }>(
        sql.raw(
          relations
            .map(name => `SELECT '${name}' AS name, count(*) AS rows FROM ONLY ${name}`)
            .join(' UNION ALL ')
        )
      );
      return rows.filter(row => Number(row.rows) > 0);
    }

    async function usedOwnedSequences() {
      const { rows } = await db.execute<{ name: string }>(sql`
        SELECT s.seqrelid::regclass::text AS name
        FROM pg_sequence s
        JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.seqrelid
          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND pg_sequence_last_value(s.seqrelid) IS NOT NULL
      `);
      return rows.map(row => row.name);
    }

    beforeEach(cleanupDbForTest);

    it('empties every table and partition, including FK-dependent rows', async () => {
      const owner = await insertTestUser();
      const organization = await createTestOrganization('Cleanup pin', owner.id, 0);
      await db.insert(exa_usage_log).values({
        kilo_user_id: owner.id,
        organization_id: organization.id,
        path: '/search',
        cost_microdollars: 1,
      });
      const removed = await insertTestUser();
      await db.execute(sql`DELETE FROM kilocode_users WHERE id = ${removed.id}`);
      expect((await nonEmptyRelations()).length).toBeGreaterThanOrEqual(3);

      await cleanupDbForTest();

      expect(await nonEmptyRelations()).toEqual([]);
    });

    it('restarts identity and serial sequences, with or without rows', async () => {
      const first = await db
        .insert(http_user_agent)
        .values([{ http_user_agent: 'a' }, { http_user_agent: 'b' }])
        .returning();
      expect(first.map(row => row.http_user_agent_id)).toEqual([1, 2]);
      await db.execute(sql`SELECT nextval(pg_get_serial_sequence('http_ip', 'http_ip_id'))`);
      expect(await usedOwnedSequences()).toEqual(
        expect.arrayContaining(['http_user_agent_http_user_agent_id_seq', 'http_ip_http_ip_id_seq'])
      );

      await cleanupDbForTest();

      expect(await usedOwnedSequences()).toEqual([]);
      const [agent] = await db.insert(http_user_agent).values({ http_user_agent: 'c' }).returning();
      const [ip] = await db.insert(http_ip).values({ http_ip: '127.0.0.1' }).returning();
      expect(agent.http_user_agent_id).toBe(1);
      expect(ip.http_ip_id).toBe(1);
    });

    it('leaves every emptied heap with zero pages, as TRUNCATE does', async () => {
      const owner = await insertTestUser();
      await createTestOrganization('Cleanup heap pin', owner.id, 0);

      await cleanupDbForTest();

      const { rows } = await db.execute<{ name: string }>(sql`
        SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname <> 'migrations'
          AND pg_relation_size(c.oid) > 0
      `);
      expect(rows).toEqual([]);
    });
  });
});
