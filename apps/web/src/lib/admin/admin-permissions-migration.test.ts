import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const migrationTag = '0187_modern_colonel_america';

describe('admin permissions migration', () => {
  it('backfills only admins that matched the previous grant-authority predicate', async () => {
    const baseUrl = new URL(process.env.POSTGRES_URL ?? '');
    if (!['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
      throw new Error('Migration test requires the local Docker PostgreSQL instance');
    }

    const databaseName = `admin_permissions_migration_${crypto.randomUUID().replaceAll('-', '')}`;
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const migrationsSource = path.resolve(__dirname, '../../../../../packages/db/src/migrations');
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-permissions-migration-'));
    const previousMigrations = path.join(temporaryRoot, 'migrations');
    const adminPool = new Pool({ connectionString: adminUrl.toString() });
    let testPool: Pool | undefined;

    try {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      await cp(migrationsSource, previousMigrations, { recursive: true });
      await unlink(path.join(previousMigrations, `${migrationTag}.sql`));

      const journalPath = path.join(previousMigrations, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<{ tag: string }>;
      };
      journal.entries = journal.entries.filter(entry => entry.tag !== migrationTag);
      await writeFile(journalPath, JSON.stringify(journal, null, 2));

      testPool = new Pool({ connectionString: databaseUrl.toString() });
      await migrate(drizzle(testPool), { migrationsFolder: previousMigrations });
      await testPool.query(
        `INSERT INTO kilocode_users
          (id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, hosted_domain, is_admin, blocked_reason)
         VALUES
          ('eligible-admin', 'eligible@kilocode.ai', 'Eligible Admin', '', 'cus_eligible', 'kilocode.ai', true, NULL),
          ('eligible-blocked-admin', 'blocked@kilocode.ai', 'Blocked Eligible Admin', '', 'cus_blocked', 'kilocode.ai', true, 'blocked'),
          ('external-admin', 'external@example.com', 'External Admin', '', 'cus_external', NULL, true, NULL),
          ('wrong-domain-admin', 'domain@kilocode.ai', 'Wrong Domain Admin', '', 'cus_domain', 'example.com', true, NULL),
          ('wrong-email-admin', 'email@example.com', 'Wrong Email Admin', '', 'cus_email', 'kilocode.ai', true, NULL),
          ('ordinary-user', 'ordinary@kilocode.ai', 'Ordinary User', '', 'cus_ordinary', 'kilocode.ai', false, NULL)`
      );

      const migrationSql = await readFile(
        path.join(migrationsSource, `${migrationTag}.sql`),
        'utf8'
      );
      await testPool.query(migrationSql);

      const migrated = await testPool.query<{
        id: string;
        is_super_admin: boolean;
        can_view_sessions: boolean;
      }>(
        `SELECT id, is_super_admin, can_view_sessions
         FROM kilocode_users
         WHERE id IN (
           'eligible-admin',
           'eligible-blocked-admin',
           'external-admin',
           'wrong-domain-admin',
           'wrong-email-admin',
           'ordinary-user'
         )
         ORDER BY id`
      );
      expect(migrated.rows).toEqual([
        { id: 'eligible-admin', is_super_admin: true, can_view_sessions: false },
        { id: 'eligible-blocked-admin', is_super_admin: true, can_view_sessions: false },
        { id: 'external-admin', is_super_admin: false, can_view_sessions: false },
        { id: 'ordinary-user', is_super_admin: false, can_view_sessions: false },
        { id: 'wrong-domain-admin', is_super_admin: false, can_view_sessions: false },
        { id: 'wrong-email-admin', is_super_admin: false, can_view_sessions: false },
      ]);

      const inserted = await testPool.query<{
        is_super_admin: boolean;
        can_view_sessions: boolean;
      }>(
        `INSERT INTO kilocode_users
          (id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, is_admin)
         VALUES ('future-admin', 'future-admin@example.com', 'Future Admin', '', 'cus_future', true)
         RETURNING is_super_admin, can_view_sessions`
      );
      expect(inserted.rows).toEqual([{ is_super_admin: false, can_view_sessions: false }]);
    } finally {
      await testPool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
