import { describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { security_findings, agent_configs } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  upsertSecurityFinding,
  supersedeDuplicateFindings,
  getLastSyncTime,
} from './security-findings';
import type { DependabotAlertRaw, ParsedSecurityFinding, SecurityReviewOwner } from '../core/types';

const rawDependabotAlertFixture: DependabotAlertRaw = {
  number: 1,
  state: 'open',
  dependency: {
    package: {
      ecosystem: 'npm',
      name: 'lodash',
    },
    manifest_path: 'package.json',
    scope: 'runtime',
  },
  security_advisory: {
    ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
    cve_id: 'CVE-2026-0001',
    summary: 'Prototype Pollution in lodash',
    description: 'A prototype pollution vulnerability',
    severity: 'high',
    cvss: {
      score: 7.5,
      vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    },
    cwes: [
      {
        cwe_id: 'CWE-1321',
        name: 'Improperly Controlled Modification of Object Prototype Attributes',
      },
    ],
  },
  security_vulnerability: {
    vulnerable_version_range: '<4.17.21',
    first_patched_version: {
      identifier: '4.17.21',
    },
  },
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
  fixed_at: null,
  dismissed_at: null,
  html_url: 'https://github.com/test/repo/security/dependabot/1',
  url: 'https://api.github.com/repos/test/repo/dependabot/alerts/1',
};

function makeFinding(overrides: Partial<ParsedSecurityFinding> = {}): ParsedSecurityFinding {
  return {
    source: 'dependabot',
    source_id: '1',
    severity: 'high',
    ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
    cve_id: 'CVE-2026-0001',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    vulnerable_version_range: '<4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    title: 'Prototype Pollution in lodash',
    description: 'A prototype pollution vulnerability',
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
    dependabot_html_url: 'https://github.com/test/repo/security/dependabot/1',
    first_detected_at: '2026-01-15T00:00:00.000Z',
    raw_data: rawDependabotAlertFixture,
    cwe_ids: ['CWE-1321'],
    cvss_score: 7.5,
    dependency_scope: 'runtime',
    ...overrides,
  };
}

describe('upsertSecurityFinding', () => {
  it('inserts a new finding and returns wasInserted=true', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };

    const result = await upsertSecurityFinding({
      ...makeFinding(),
      owner,
      repoFullName: 'test-org/test-repo',
    });

    expect(result.wasInserted).toBe(true);
    expect(result.findingId).toBeTruthy();
    expect(result.previousStatus).toBeNull();

    const [row] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, result.findingId));

    expect(row.severity).toBe('high');
    expect(row.package_name).toBe('lodash');
    expect(row.owned_by_user_id).toBe(user.id);
    expect(row.status).toBe('open');
  });

  it('updates an existing finding and returns wasInserted=false with previousStatus', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/update-repo';

    const first = await upsertSecurityFinding({
      ...makeFinding({ source_id: '10' }),
      owner,
      repoFullName: repo,
    });
    expect(first.wasInserted).toBe(true);

    const second = await upsertSecurityFinding({
      ...makeFinding({ source_id: '10', status: 'fixed', severity: 'critical' }),
      owner,
      repoFullName: repo,
    });

    expect(second.wasInserted).toBe(false);
    expect(second.findingId).toBe(first.findingId);
    expect(second.previousStatus).toBe('open');

    const [row] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, first.findingId));

    expect(row.status).toBe('fixed');
    expect(row.severity).toBe('critical');
  });

  it('uses repo_full_name + source + source_id as the unique key', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/unique-key-repo';

    const a = await upsertSecurityFinding({
      ...makeFinding({ source_id: '20' }),
      owner,
      repoFullName: repo,
    });
    const b = await upsertSecurityFinding({
      ...makeFinding({ source_id: '21' }),
      owner,
      repoFullName: repo,
    });

    expect(a.findingId).not.toBe(b.findingId);
    expect(a.wasInserted).toBe(true);
    expect(b.wasInserted).toBe(true);

    const rows = await db
      .select()
      .from(security_findings)
      .where(
        and(
          eq(security_findings.repo_full_name, repo),
          eq(security_findings.owned_by_user_id, user.id)
        )
      );

    expect(rows).toHaveLength(2);
  });

  it('handles null cwe_ids without serialization error', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };

    const result = await upsertSecurityFinding({
      ...makeFinding({ source_id: '30', cwe_ids: null }),
      owner,
      repoFullName: 'test-org/null-cwe-repo',
    });

    expect(result.wasInserted).toBe(true);

    const [row] = await db
      .select({ cwe_ids: security_findings.cwe_ids })
      .from(security_findings)
      .where(eq(security_findings.id, result.findingId));

    expect(row.cwe_ids).toBeNull();
  });
});

describe('supersedeDuplicateFindings', () => {
  it('supersedes older duplicate for same ghsa/package/manifest, keeping highest source_id', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/supersede-basic-repo';

    // Insert two findings with different source_ids but same ghsa/package/manifest
    const older = await upsertSecurityFinding({
      ...makeFinding({ source_id: '5', ghsa_id: 'GHSA-aaaa-bbbb-cccc' }),
      owner,
      repoFullName: repo,
    });
    const newer = await upsertSecurityFinding({
      ...makeFinding({ source_id: '10', ghsa_id: 'GHSA-aaaa-bbbb-cccc' }),
      owner,
      repoFullName: repo,
    });

    const result = await supersedeDuplicateFindings(repo);
    expect(result.count).toBe(1);
    expect(result.supersededFindingIds).toEqual([older.findingId]);

    const [olderRow] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, older.findingId));

    expect(olderRow.status).toBe('ignored');
    expect(olderRow.ignored_reason).toBe(`superseded:${newer.findingId}`);
    expect(olderRow.ignored_by).toBe('system');

    const [newerRow] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, newer.findingId));

    expect(newerRow.status).toBe('open');
  });

  it('does not supersede findings with different manifest paths', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/supersede-manifest-repo';

    await upsertSecurityFinding({
      ...makeFinding({
        source_id: '30',
        ghsa_id: 'GHSA-dddd-eeee-ffff',
        manifest_path: 'package.json',
      }),
      owner,
      repoFullName: repo,
    });
    await upsertSecurityFinding({
      ...makeFinding({
        source_id: '31',
        ghsa_id: 'GHSA-dddd-eeee-ffff',
        manifest_path: 'apps/web/package.json',
      }),
      owner,
      repoFullName: repo,
    });

    const result = await supersedeDuplicateFindings(repo);
    expect(result.count).toBe(0);
    expect(result.supersededFindingIds).toEqual([]);

    const rows = await db
      .select()
      .from(security_findings)
      .where(and(eq(security_findings.repo_full_name, repo), eq(security_findings.status, 'open')));

    expect(rows).toHaveLength(2);
  });

  it('does not supersede findings with null ghsa_id', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/supersede-null-ghsa-repo';

    await upsertSecurityFinding({
      ...makeFinding({ source_id: '40', ghsa_id: null }),
      owner,
      repoFullName: repo,
    });
    await upsertSecurityFinding({
      ...makeFinding({ source_id: '41', ghsa_id: null }),
      owner,
      repoFullName: repo,
    });

    const result = await supersedeDuplicateFindings(repo);
    expect(result.count).toBe(0);
    expect(result.supersededFindingIds).toEqual([]);
  });

  it('does not supersede findings that are not open', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/supersede-status-repo';

    await upsertSecurityFinding({
      ...makeFinding({ source_id: '50', ghsa_id: 'GHSA-gggg-hhhh-iiii', status: 'fixed' }),
      owner,
      repoFullName: repo,
    });
    await upsertSecurityFinding({
      ...makeFinding({ source_id: '51', ghsa_id: 'GHSA-gggg-hhhh-iiii', status: 'open' }),
      owner,
      repoFullName: repo,
    });

    const result = await supersedeDuplicateFindings(repo);
    expect(result.count).toBe(0);
    expect(result.supersededFindingIds).toEqual([]);

    // The open one should remain open (it's the only open one in the group)
    const [openRow] = await db
      .select()
      .from(security_findings)
      .where(and(eq(security_findings.repo_full_name, repo), eq(security_findings.status, 'open')));

    expect(openRow).toBeDefined();
    expect(openRow.source_id).toBe('51');
  });

  it('is idempotent', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/supersede-idempotent-repo';

    await upsertSecurityFinding({
      ...makeFinding({ source_id: '60', ghsa_id: 'GHSA-jjjj-kkkk-llll' }),
      owner,
      repoFullName: repo,
    });
    await upsertSecurityFinding({
      ...makeFinding({ source_id: '61', ghsa_id: 'GHSA-jjjj-kkkk-llll' }),
      owner,
      repoFullName: repo,
    });

    const firstResult = await supersedeDuplicateFindings(repo);
    expect(firstResult.count).toBe(1);

    const secondResult = await supersedeDuplicateFindings(repo);
    expect(secondResult.count).toBe(0);
    expect(secondResult.supersededFindingIds).toEqual([]);
  });

  it('handles multiple duplicate groups in the same repo independently', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };
    const repo = 'test-org/supersede-multi-group-repo';

    // Group 1: GHSA-aaaa with two findings
    const group1Older = await upsertSecurityFinding({
      ...makeFinding({ source_id: '70', ghsa_id: 'GHSA-mmmm-nnnn-oooo', package_name: 'lodash' }),
      owner,
      repoFullName: repo,
    });
    const group1Newer = await upsertSecurityFinding({
      ...makeFinding({ source_id: '71', ghsa_id: 'GHSA-mmmm-nnnn-oooo', package_name: 'lodash' }),
      owner,
      repoFullName: repo,
    });

    // Group 2: GHSA-bbbb with two findings
    const group2Older = await upsertSecurityFinding({
      ...makeFinding({ source_id: '80', ghsa_id: 'GHSA-pppp-qqqq-rrrr', package_name: 'express' }),
      owner,
      repoFullName: repo,
    });
    const group2Newer = await upsertSecurityFinding({
      ...makeFinding({ source_id: '81', ghsa_id: 'GHSA-pppp-qqqq-rrrr', package_name: 'express' }),
      owner,
      repoFullName: repo,
    });

    const result = await supersedeDuplicateFindings(repo);
    expect(result.count).toBe(2);
    expect(result.supersededFindingIds).toEqual(
      expect.arrayContaining([group1Older.findingId, group2Older.findingId])
    );

    // Verify group 1
    const [g1OlderRow] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, group1Older.findingId));
    expect(g1OlderRow.status).toBe('ignored');
    expect(g1OlderRow.ignored_reason).toBe(`superseded:${group1Newer.findingId}`);

    const [g1NewerRow] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, group1Newer.findingId));
    expect(g1NewerRow.status).toBe('open');

    // Verify group 2
    const [g2OlderRow] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, group2Older.findingId));
    expect(g2OlderRow.status).toBe('ignored');
    expect(g2OlderRow.ignored_reason).toBe(`superseded:${group2Newer.findingId}`);

    const [g2NewerRow] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, group2Newer.findingId));
    expect(g2NewerRow.status).toBe('open');
  });
});

describe('getLastSyncTime', () => {
  it('returns runtime_state.last_synced_at when present on agent_configs', async () => {
    const user = await insertTestUser();
    const expectedTime = '2026-03-01T12:00:00.000Z';

    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'security_scan',
      platform: 'github',
      config: {},
      is_enabled: true,
      runtime_state: { last_synced_at: expectedTime },
      created_by: 'test',
    });

    const result = await getLastSyncTime({ owner: { userId: user.id } });
    expect(result).toBe(expectedTime);
  });

  it('returns null for owner-level query when runtime_state has no last_synced_at', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };

    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'security_scan',
      platform: 'github',
      config: {},
      is_enabled: true,
      runtime_state: {},
      created_by: 'test',
    });

    await upsertSecurityFinding({
      ...makeFinding({ source_id: '100' }),
      owner,
      repoFullName: 'test-org/fallback-repo',
    });

    // Owner-level should NOT fall back to MAX(findings) — that overstates freshness after partial failures
    const result = await getLastSyncTime({ owner });
    expect(result).toBeNull();
  });

  it('returns null for owner-level query when no agent_config exists', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };

    await upsertSecurityFinding({
      ...makeFinding({ source_id: '200' }),
      owner,
      repoFullName: 'test-org/no-config-repo',
    });

    // Owner-level should return null, not fall back to MAX(findings)
    const result = await getLastSyncTime({ owner });
    expect(result).toBeNull();
  });

  it('returns null when no config and no findings exist', async () => {
    const user = await insertTestUser();

    const result = await getLastSyncTime({ owner: { userId: user.id } });
    expect(result).toBeNull();
  });

  it('skips runtime_state and uses findings when repoFullName is provided', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };

    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'security_scan',
      platform: 'github',
      config: {},
      is_enabled: true,
      runtime_state: { last_synced_at: '2026-06-01T00:00:00.000Z' },
      created_by: 'test',
    });

    await upsertSecurityFinding({
      ...makeFinding({ source_id: '300' }),
      owner,
      repoFullName: 'test-org/specific-repo',
    });

    const result = await getLastSyncTime({ owner, repoFullName: 'test-org/specific-repo' });
    // Should return the finding's last_synced_at, not the owner-level runtime_state
    expect(result).not.toBeNull();
    expect(result).not.toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns null for repo with zero findings (no per-repo sync metadata)', async () => {
    const user = await insertTestUser();
    const owner: SecurityReviewOwner = { userId: user.id };

    await db.insert(agent_configs).values({
      owned_by_user_id: user.id,
      agent_type: 'security_scan',
      platform: 'github',
      config: {},
      is_enabled: true,
      runtime_state: { last_synced_at: '2026-03-01T12:00:00.000Z' },
      created_by: 'test',
    });

    // No findings for this repo — could be a clean repo or one added after the last sync.
    // Without per-repo sync metadata, returning null is safer than overstating freshness.
    const result = await getLastSyncTime({ owner, repoFullName: 'test-org/clean-repo' });
    expect(result).toBeNull();
  });
});
