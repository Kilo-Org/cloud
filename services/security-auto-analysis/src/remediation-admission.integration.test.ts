import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  security_audit_log,
  security_findings,
  security_remediation_attempts,
  security_remediations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { buildSecurityFindingAnalysisInput } from '@kilocode/worker-utils/security-remediation-policy';
import { admitRemediationAttempt } from './remediation.js';
import { DEFAULT_SECURITY_AGENT_CONFIG } from './types.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUserId = `security-remediation-admission-${randomUUID()}`;
const findingId = randomUUID();
let client: ReturnType<typeof createDrizzleClient>;

describe('security remediation admission persistence', () => {
  beforeAll(async () => {
    client = createDrizzleClient({ connectionString, ssl: false });
    await client.db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: `${testUserId}@example.com`,
      google_user_name: 'Security Remediation Admission Test',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_${randomUUID()}`,
    });
    await client.db.insert(security_findings).values({
      id: findingId,
      owned_by_user_id: testUserId,
      repo_full_name: 'kilo/remediation-admission-test',
      source: 'dependabot',
      source_id: 'remediation-admission-test',
      severity: 'high',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      title: 'Remediation admission test finding',
      status: 'open',
      analysis_status: 'pending',
    });
  });

  afterAll(async () => {
    await client.db.delete(security_audit_log).where(eq(security_audit_log.finding_id, findingId));
    await client.db
      .delete(security_remediation_attempts)
      .where(eq(security_remediation_attempts.finding_id, findingId));
    await client.db
      .delete(security_remediations)
      .where(eq(security_remediations.finding_id, findingId));
    await client.db.delete(security_findings).where(eq(security_findings.id, findingId));
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
    await client.pool.end();
  });

  it('creates no remediation state when analysis is required', async () => {
    const result = await admitRemediationAttempt({
      db: client.db as never,
      findingId,
      origin: 'manual',
      owner: { type: 'user', id: testUserId },
      runtimeConfig: {
        config: DEFAULT_SECURITY_AGENT_CONFIG,
        isAgentEnabled: true,
        repoFullNamesInScope: ['kilo/remediation-admission-test'],
      },
    });

    expect(result).toEqual({ admitted: false, reason: 'analysis_required' });
    await expect(
      client.db
        .select({ id: security_remediations.id })
        .from(security_remediations)
        .where(eq(security_remediations.finding_id, findingId))
    ).resolves.toEqual([]);
    await expect(
      client.db
        .select({ id: security_remediation_attempts.id })
        .from(security_remediation_attempts)
        .where(eq(security_remediation_attempts.finding_id, findingId))
    ).resolves.toEqual([]);
  });

  it('admits the Worker projection using the database completion timestamp fallback', async () => {
    const analysisInput = buildSecurityFindingAnalysisInput({
      source: 'dependabot',
      source_id: 'remediation-admission-test',
      status: 'open',
      severity: 'high',
      repo_full_name: 'kilo/remediation-admission-test',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      dependency_scope: null,
      cve_id: null,
      ghsa_id: null,
      cwe_ids: null,
      cvss_score: null,
      title: 'Remediation admission test finding',
      description: null,
      vulnerable_version_range: null,
      patched_version: null,
      manifest_path: null,
      raw_data: null,
    });
    await client.db
      .update(security_findings)
      .set({
        analysis_status: 'completed',
        analysis_completed_at: '2026-06-16T12:00:00.000Z',
        last_synced_at: '2026-06-16T12:05:00.000Z',
        analysis: {
          analyzedAt: null,
          findingDataSnapshot: analysisInput,
          sandboxAnalysis: {
            isExploitable: true,
            exploitabilityReasoning: 'Vulnerable package is reachable.',
            usageLocations: [],
            suggestedFix: 'Upgrade lodash to a patched version.',
            suggestedAction: 'open_pr',
            summary: 'Reachable vulnerable dependency.',
            rawMarkdown: '',
            analysisAt: null,
          },
        } as never,
      })
      .where(eq(security_findings.id, findingId));

    const result = await admitRemediationAttempt({
      db: client.db as never,
      findingId,
      origin: 'manual',
      owner: { type: 'user', id: testUserId },
      requestedByUserId: testUserId,
      requestedByActor: {
        id: testUserId,
        email: `${testUserId}@example.com`,
        name: 'Security Remediation Admission Test',
        api_token_pepper: null,
        is_admin: false,
      },
      runtimeConfig: {
        config: DEFAULT_SECURITY_AGENT_CONFIG,
        isAgentEnabled: true,
        repoFullNamesInScope: ['kilo/remediation-admission-test'],
      },
    });

    expect(result).toMatchObject({ admitted: true, attemptNumber: 1 });
    await expect(
      client.db
        .select({ analysisCompletedAt: security_remediation_attempts.analysis_completed_at })
        .from(security_remediation_attempts)
        .where(eq(security_remediation_attempts.finding_id, findingId))
    ).resolves.toHaveLength(1);
    await expect(
      client.db
        .select({ id: security_remediations.id })
        .from(security_remediations)
        .where(eq(security_remediations.finding_id, findingId))
    ).resolves.toHaveLength(1);
  });
});
