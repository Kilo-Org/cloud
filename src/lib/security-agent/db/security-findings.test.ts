import { describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { security_findings } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { upsertSecurityFinding } from './security-findings';
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
