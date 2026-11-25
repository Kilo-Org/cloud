import type pg from 'pg';
import { z } from 'zod';

/**
 * The deploy-time check for roles outside the UTS role matrix (README, "Platform roles").
 *
 * * It lists the members of `pg_read_all_data` and `pg_write_all_data`, which can read or write
 *   every table in the database, hashes and emails included.
 * * It confirms that the Supabase API roles (`anon`, `authenticated`, `service_role`) hold no
 *   privilege on the identity-store schemas or anything in them, whether granted directly,
 *   through PUBLIC or through a role they inherit. A role that does not exist holds nothing.
 */

export const PLATFORM_ROLES = ['anon', 'authenticated', 'service_role'] as const;

export const IDENTITY_STORE_SCHEMAS = ['uts', 'uts_read', 'uts_migrations'] as const;

export const PREDEFINED_DATA_ROLES = ['pg_read_all_data', 'pg_write_all_data'] as const;

const DataRoleMemberSchema = z.strictObject({ role: z.string(), member: z.string() });
export type DataRoleMember = z.output<typeof DataRoleMemberSchema>;

const PlatformRoleFindingSchema = z.strictObject({ role: z.string(), privilege: z.string() });
export type PlatformRoleFinding = z.output<typeof PlatformRoleFindingSchema>;

const PresentRoleSchema = z.strictObject({ role: z.string() });

export type PlatformAccessReport = {
  dataRoleMembers: DataRoleMember[];
  /** Platform roles that exist on this server. */
  presentRoles: string[];
  /** Every privilege a platform role holds on the identity store; empty when the check passes. */
  findings: PlatformRoleFinding[];
};

const DATA_ROLE_MEMBERS = `
  SELECT target.rolname::text AS role, member.rolname::text AS member
  FROM pg_auth_members AS membership
  JOIN pg_roles AS target ON target.oid = membership.roleid
  JOIN pg_roles AS member ON member.oid = membership.member
  WHERE target.rolname = ANY ($1::text[])
  ORDER BY 1, 2`;

const PRESENT_ROLES = `
  SELECT rolname::text AS role FROM pg_roles WHERE rolname = ANY ($1::text[]) ORDER BY 1`;

// The has_*_privilege functions count direct grants, PUBLIC grants, inherited roles and the
// predefined data roles alike.
const FINDINGS = `
  WITH platform AS (
    SELECT oid, rolname::text AS role FROM pg_roles WHERE rolname = ANY ($1::text[])
  ),
  schemas AS (
    SELECT oid, nspname::text AS name FROM pg_namespace WHERE nspname = ANY ($2::text[])
  )
  SELECT platform.role, finding.privilege
  FROM platform
  CROSS JOIN LATERAL (
    SELECT 'member of ' || data_role AS privilege
    FROM unnest($3::text[]) AS data_role
    WHERE pg_has_role(platform.oid, data_role, 'USAGE')
    UNION ALL
    SELECT privilege || ' on schema ' || schemas.name
    FROM schemas CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS privilege
    WHERE has_schema_privilege(platform.oid, schemas.oid, privilege)
    UNION ALL
    SELECT privilege || ' on ' || schemas.name || '.' || class.relname
    FROM pg_class AS class
    JOIN schemas ON schemas.oid = class.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
                            'TRIGGER']) AS privilege
    WHERE class.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (has_table_privilege(platform.oid, class.oid, privilege)
        OR (privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          AND has_any_column_privilege(platform.oid, class.oid, privilege)))
    UNION ALL
    SELECT privilege || ' on sequence ' || schemas.name || '.' || class.relname
    FROM pg_class AS class
    JOIN schemas ON schemas.oid = class.relnamespace
    CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS privilege
    WHERE class.relkind = 'S' AND has_sequence_privilege(platform.oid, class.oid, privilege)
    UNION ALL
    SELECT 'EXECUTE on ' || procedure.oid::regprocedure::text
    FROM pg_proc AS procedure
    JOIN schemas ON schemas.oid = procedure.pronamespace
    WHERE has_function_privilege(platform.oid, procedure.oid, 'EXECUTE')
  ) AS finding
  ORDER BY 1, 2`;

export async function checkPlatformAccess(client: pg.Client): Promise<PlatformAccessReport> {
  const members = await client.query(DATA_ROLE_MEMBERS, [PREDEFINED_DATA_ROLES]);
  const present = await client.query(PRESENT_ROLES, [PLATFORM_ROLES]);
  const findings = await client.query(FINDINGS, [
    PLATFORM_ROLES,
    IDENTITY_STORE_SCHEMAS,
    PREDEFINED_DATA_ROLES,
  ]);
  return {
    dataRoleMembers: z.array(DataRoleMemberSchema).parse(members.rows),
    presentRoles: z
      .array(PresentRoleSchema)
      .parse(present.rows)
      .map(row => row.role),
    findings: z.array(PlatformRoleFindingSchema).parse(findings.rows),
  };
}
