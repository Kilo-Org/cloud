import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, checkPlatformAccess } from '../../scripts/platform-access';
import { TestDatabase } from './harness';

/**
 * The platform roles exist only inside each test's transaction, which rolls back, so the local
 * server keeps no `anon`, `authenticated` or `service_role` role afterwards.
 */

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await TestDatabase.create();
  admin = await db.connect();
});
afterAll(() => db.drop());

async function inRolledBackTransaction(work: () => Promise<void>) {
  await admin.query('BEGIN');
  try {
    for (const role of PLATFORM_ROLES) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    await work();
  } finally {
    await admin.query('ROLLBACK');
  }
}

describe('the platform access check', () => {
  it('pass when the platform roles hold nothing on the identity store', async () => {
    await inRolledBackTransaction(async () => {
      const report = await checkPlatformAccess(admin);
      expect(report.presentRoles).toEqual([...PLATFORM_ROLES].sort());
      expect(report.findings).toEqual([]);
      expect(report.dataRoleMembers).toEqual([]);
    });
  });

  it('report a direct grant and a grant through an inherited role', async () => {
    await inRolledBackTransaction(async () => {
      await admin.query('CREATE ROLE uts_t_platform_group NOLOGIN');
      await admin.query('GRANT uts_t_platform_group TO service_role');
      await admin.query('SET LOCAL ROLE uts_owner');
      await admin.query('GRANT SELECT ON uts.accounts TO authenticated');
      await admin.query('GRANT USAGE ON SCHEMA uts_read TO uts_t_platform_group');
      await admin.query('GRANT SELECT (id) ON uts_read.accounts TO uts_t_platform_group');
      await admin.query('RESET ROLE');

      const { findings } = await checkPlatformAccess(admin);
      expect(findings).toEqual([
        { role: 'authenticated', privilege: 'SELECT on uts.accounts' },
        { role: 'service_role', privilege: 'SELECT on uts_read.accounts' },
        { role: 'service_role', privilege: 'USAGE on schema uts_read' },
      ]);
    });
  });

  it('report what a role reachable only through SET ROLE holds', async () => {
    await inRolledBackTransaction(async () => {
      // A membership that passes no privilege on until the session runs `SET ROLE`.
      await admin.query('CREATE ROLE uts_t_platform_switch NOLOGIN');
      await admin.query('GRANT uts_t_platform_switch TO anon WITH INHERIT FALSE, SET TRUE');
      await admin.query('SET LOCAL ROLE uts_owner');
      await admin.query('GRANT SELECT ON uts.refresh_grants TO uts_t_platform_switch');
      await admin.query('GRANT EXECUTE ON FUNCTION uts.lookup_pat(bytea) TO uts_t_platform_switch');
      await admin.query('RESET ROLE');

      const { findings } = await checkPlatformAccess(admin);
      expect(findings).toEqual([
        {
          role: 'anon',
          privilege: 'EXECUTE on uts.lookup_pat(bytea) through SET ROLE uts_t_platform_switch',
        },
        {
          role: 'anon',
          privilege: 'SELECT on uts.refresh_grants through SET ROLE uts_t_platform_switch',
        },
      ]);
    });
  });

  it('report nothing for a role that can switch only to roles holding nothing', async () => {
    await inRolledBackTransaction(async () => {
      await admin.query('CREATE ROLE uts_t_platform_empty NOLOGIN');
      await admin.query('GRANT uts_t_platform_empty TO anon WITH INHERIT FALSE, SET TRUE');
      expect((await checkPlatformAccess(admin)).findings).toEqual([]);
    });
  });

  it('report EXECUTE on an identity-store function', async () => {
    await inRolledBackTransaction(async () => {
      await admin.query('SET LOCAL ROLE uts_owner');
      await admin.query('GRANT EXECUTE ON FUNCTION uts.lookup_pat(bytea) TO anon');
      await admin.query('RESET ROLE');

      const { findings } = await checkPlatformAccess(admin);
      expect(findings).toEqual([{ role: 'anon', privilege: 'EXECUTE on uts.lookup_pat(bytea)' }]);
    });
  });
});
