import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDatabase } from './harness';

/**
 * The hot-path reads (design section 3: mint, refresh, PAT lookup, web session check) each reach
 * a credential through one unique-index probe on its hash, plus primary-key probes for the rows
 * that hang off it. Each case plans a stored function's own body: the PAT and bot key lookups, and
 * the grant reads that the one-statement mint and refresh functions call. The tables hold a few
 * thousand analyzed rows, so the planner sees real selectivity rather than empty tables.
 */

let db: TestDatabase;
let owner: pg.Client;

const SEED = `
  INSERT INTO uts.accounts (id, primary_email)
  SELECT 'oauth/seed-' || n, 'seed' || n || '@example.com' FROM generate_series(1, 2000) AS n;

  INSERT INTO uts.org_sso_policies (org_id, enforcement, event_version)
  SELECT md5('org' || n)::uuid, 'optional', 1 FROM generate_series(1, 2000) AS n;

  -- Each account belongs to two of 200 organizations.
  INSERT INTO uts.org_memberships (org_id, account_id, role, event_version)
  SELECT md5('org' || ((n + shift) % 200))::uuid, 'oauth/seed-' || n, 'member', 1
  FROM generate_series(1, 2000) AS n CROSS JOIN generate_series(0, 1) AS shift;

  INSERT INTO uts.device_sessions (account_id, client_class, device_label, platform, auth_time, amr)
  SELECT id, 'desktop', 'seed', 'linux', now(), '{passkey}' FROM uts.accounts;

  INSERT INTO uts.refresh_grants
    (account_id, device_session_id, client_id, client_class, token_hash, dpop_jkt, allowed_scopes,
     org_id, idle_expires_at, expires_at)
  SELECT account_id, id, 'kilo-cli', 'desktop', sha256(convert_to(id::text || copy, 'UTF8')),
         sha256(convert_to(id::text, 'UTF8')), '{gateway:models.read}',
         md5('org' || (substr(account_id, 12)::integer % 200))::uuid,
         now() + interval '30 days', now() + interval '180 days'
  FROM uts.device_sessions
  CROSS JOIN generate_series(1, 2) AS copy;

  INSERT INTO uts.browser_sessions (account_id, token_hash, auth_time, amr, idle_expires_at, expires_at)
  SELECT id, sha256(convert_to('browser' || id, 'UTF8')), now(), '{oauth}',
         now() + interval '14 days', now() + interval '30 days'
  FROM uts.accounts;

  -- One pass per session and gated action, since a pass serves only its own action and one row.
  INSERT INTO uts.gate_passes (account_id, browser_session_id, tier, action, satisfied_by, expires_at)
  SELECT account_id, id, 'b', action::uts.gated_action, '{recent_sign_in}', now() + interval '10 minutes'
  FROM uts.browser_sessions
  CROSS JOIN unnest(ARRAY['third_party_approve', 'pat_create', 'bot_key_create']) AS action;

  -- Many clients, so the planner probes the client's primary key rather than scanning the table.
  INSERT INTO uts.third_party_clients
    (client_id, client_name, redirect_uris, document, fetched_at, cache_expires_at)
  SELECT CASE WHEN n = 0 THEN 'https://client.example.com/metadata'
              ELSE 'https://client' || n || '.example.com/metadata' END,
         'Example', '{https://client.example.com/callback}'::text[], '{}'::jsonb, now(),
         now() + interval '1 hour'
  FROM generate_series(0, 2000) AS n;

  INSERT INTO uts.third_party_consents (account_id, client_id, scopes, gate_pass_id)
  SELECT account_id, 'https://client.example.com/metadata', '{mcp:tools.read}', id
  FROM uts.gate_passes WHERE action = 'third_party_approve';

  -- Families bound to one of the account's organizations, as the refresh grants are.
  INSERT INTO uts.third_party_grant_families
    (account_id, client_id, consent_id, scopes, org_id, auth_time, amr, expires_at)
  SELECT account_id, client_id, id, scopes,
         md5('org' || (substr(account_id, 12)::integer % 200))::uuid, now(), '{oauth}',
         now() + interval '90 days'
  FROM uts.third_party_consents;

  INSERT INTO uts.third_party_refresh_tokens (family_id, token_hash, idle_expires_at)
  SELECT id, sha256(convert_to(id::text, 'UTF8')), now() + interval '30 days'
  FROM uts.third_party_grant_families;

  INSERT INTO uts.third_party_rotated_tokens (token_key, family_id, family_expires_at)
  SELECT gen_random_uuid(), id, expires_at
  FROM uts.third_party_grant_families
  CROSS JOIN generate_series(1, 3);

  INSERT INTO uts.personal_access_tokens
    (account_id, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
  SELECT account_id, 'seed', sha256(convert_to('pat' || id, 'UTF8')), 'abcd', 'gateway',
         'gateway:models.read', id, now() + interval '90 days'
  FROM uts.gate_passes WHERE action = 'pat_create';

  INSERT INTO uts.org_bot_keys
    (org_id, created_by, name, token_hash, last_four, audience, scope, gate_pass_id, expires_at)
  SELECT md5('org' || account_id)::uuid, account_id, 'seed', sha256(convert_to('bot' || id, 'UTF8')),
         'wxyz', 'gateway', 'gateway:models.read', id, now() + interval '90 days'
  FROM uts.gate_passes WHERE action = 'bot_key_create';

  ANALYZE uts.accounts, uts.org_sso_policies, uts.org_memberships, uts.device_sessions,
    uts.refresh_grants, uts.browser_sessions, uts.third_party_clients,
    uts.third_party_grant_families, uts.third_party_refresh_tokens,
    uts.third_party_rotated_tokens, uts.third_party_consents, uts.personal_access_tokens,
    uts.org_bot_keys;
`;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
  await owner.query(SEED);
});
afterAll(() => db.drop());

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};

function scans(node: PlanNode): { relation: string; node: string; index: string | undefined }[] {
  const own =
    node['Relation Name'] === undefined
      ? []
      : [{ relation: node['Relation Name'], node: node['Node Type'], index: node['Index Name'] }];
  return [...own, ...(node.Plans ?? []).flatMap(scans)];
}

async function functionBody(signature: string): Promise<string> {
  const result = await owner.query<{ prosrc: string }>(
    'SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure',
    [signature]
  );
  return result.rows[0].prosrc;
}

const BROWSER_SESSION_READ = `
  SELECT id, account_id, status, idle_expires_at, expires_at
  FROM uts.browser_sessions
  WHERE token_hash = $1`;

const CASES: [string, () => Promise<string>, Record<string, string>][] = [
  [
    'a PAT lookup',
    () => functionBody('uts.lookup_pat(bytea)'),
    { personal_access_tokens: 'personal_access_tokens_token_hash_key', accounts: 'accounts_pkey' },
  ],
  [
    'an org bot key lookup',
    () => functionBody('uts.lookup_bot_key(bytea)'),
    { org_bot_keys: 'org_bot_keys_token_hash_key' },
  ],
  [
    'a mint or first-party refresh',
    () => functionBody('uts.read_refresh_grant(bytea)'),
    {
      refresh_grants: 'refresh_grants_token_hash_key',
      device_sessions: 'device_sessions_pkey',
      accounts: 'accounts_pkey',
      org_memberships: 'org_memberships_pkey',
      org_sso_policies: 'org_sso_policies_pkey',
    },
  ],
  [
    'a third-party refresh',
    () => functionBody('uts.read_third_party_refresh_token(bytea)'),
    {
      third_party_refresh_tokens: 'third_party_refresh_tokens_token_hash_key',
      third_party_grant_families: 'third_party_grant_families_pkey',
      third_party_consents: 'third_party_consents_pkey',
      accounts: 'accounts_pkey',
      third_party_clients: 'third_party_clients_pkey',
      org_memberships: 'org_memberships_pkey',
      org_sso_policies: 'org_sso_policies_pkey',
    },
  ],
  [
    'a replaced third-party token',
    () => functionBody('uts.read_rotated_third_party_token(bytea)'),
    {
      third_party_rotated_tokens: 'third_party_rotated_tokens_pkey',
      third_party_grant_families: 'third_party_grant_families_pkey',
    },
  ],
  [
    'a web session check',
    async () => BROWSER_SESSION_READ,
    { browser_sessions: 'browser_sessions_token_hash_key' },
  ],
];

describe('hot-path reads', () => {
  it.each(CASES)('plan %s as index probes only', async (name, statement, expected) => {
    const prepared = `probe_${name.replaceAll(/[^a-z]/g, '_')}`;
    await owner.query(`PREPARE ${prepared}(bytea) AS ${await statement()}`);
    try {
      const plan = await owner.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `EXPLAIN (FORMAT JSON) EXECUTE ${prepared}(decode(repeat('00', 32), 'hex'))`
      );
      const found = scans(plan.rows[0]['QUERY PLAN'][0].Plan);
      // `Index Scan` or `Index Only Scan`; never a sequential or bitmap scan.
      expect(found.filter(scan => !scan.node.startsWith('Index '))).toEqual([]);
      expect(Object.fromEntries(found.map(scan => [scan.relation, scan.index]))).toEqual(expected);
      expect(found).toHaveLength(Object.keys(expected).length);
    } finally {
      await owner.query(`DEALLOCATE ${prepared}`);
    }
  });
});
