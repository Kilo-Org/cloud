import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as QueriesModule from './db/queries.js';
import { getSecurityFindingById } from './db/queries.js';
import { logger } from './logger.js';
import {
  admitRemediationAttempt,
  buildRemediationPrepareSessionBody,
  buildRemediationPrompt,
} from './remediation.js';
import { DEFAULT_SECURITY_AGENT_CONFIG } from './types.js';

vi.mock('./db/queries.js', async importOriginal => ({
  ...(await importOriginal<typeof QueriesModule>()),
  getSecurityFindingById: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('security remediation admission', () => {
  it('reports a missing finding without starting persistence', async () => {
    const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const transaction = vi.fn();
    const log = vi.spyOn(logger, 'info');
    vi.mocked(getSecurityFindingById).mockResolvedValue(null as never);

    await expect(
      admitRemediationAttempt({
        db: { transaction } as never,
        findingId,
        origin: 'manual',
      })
    ).resolves.toEqual({ admitted: false, reason: 'finding_not_found' });

    expect(transaction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Security remediation admission rejected', {
      finding_id: findingId,
      origin: 'manual',
      reason: 'finding_not_found',
    });
  });
});

describe('security remediation approval gate', () => {
  const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const validFinding = {
    id: findingId,
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    repo_full_name: 'kilo/repo',
    source: 'dependabot',
    source_id: '42',
    status: 'open',
    severity: 'high',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    dependency_scope: 'runtime',
    cve_id: null,
    ghsa_id: null,
    cwe_ids: null,
    cvss_score: null,
    title: 'Command Injection in lodash',
    description: null,
    vulnerable_version_range: '< 4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    raw_data: { updated_at: '2026-01-01T00:00:00.000Z' },
    last_synced_at: '2026-01-02T00:00:00.000Z',
    analysis_status: 'completed',
    analysis_completed_at: '2026-01-02T00:05:00.000Z',
    analysis: {
      analyzedAt: '2026-01-02T00:05:00.000Z',
      sandboxAnalysis: {
        isExploitable: true,
        suggestedAction: 'open_pr',
        suggestedFix: 'Upgrade lodash to 4.17.21',
        usageLocations: [],
        summary: 'Reachable vulnerable lodash usage',
        rawMarkdown: '',
        analysisAt: '2026-01-02T00:05:00.000Z',
      },
    },
  };

  const emptyAttemptsDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };

  function approvalRequiredRuntimeConfig() {
    return {
      config: {
        ...DEFAULT_SECURITY_AGENT_CONFIG,
        auto_remediation_enabled: true,
        auto_remediation_require_approval: true,
      },
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
    };
  }

  it('rejects auto_policy admission with approval_required when approval is required', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(validFinding as never);

    await expect(
      admitRemediationAttempt({
        db: emptyAttemptsDb as never,
        findingId,
        origin: 'auto_policy',
        owner: { type: 'user', id: 'user-1' },
        runtimeConfig: approvalRequiredRuntimeConfig(),
      })
    ).resolves.toEqual({ admitted: false, reason: 'approval_required' });
  });

  it('never rejects manual admission for the approval flag', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      ...validFinding,
      analysis: {
        ...validFinding.analysis,
        sandboxAnalysis: {
          ...validFinding.analysis.sandboxAnalysis,
          suggestedAction: 'monitor',
        },
      },
    } as never);

    await expect(
      admitRemediationAttempt({
        db: emptyAttemptsDb as never,
        findingId,
        origin: 'manual',
        owner: { type: 'user', id: 'user-1' },
        runtimeConfig: approvalRequiredRuntimeConfig(),
      })
    ).resolves.toEqual({ admitted: false, reason: 'monitor_required' });
  });
});

describe('security remediation launch contract', () => {
  it('does not pass the new remediation branch as upstream checkout branch', () => {
    const body = buildRemediationPrepareSessionBody({
      prompt: 'Fix vulnerable package',
      model: 'kilo-auto/frontier',
      repoFullName: 'Kilo-Org/security-agent-testbed',
      organizationId: undefined,
      callbackTarget: {
        url: 'https://security-auto-analysis.test/internal/security-remediation-callback/attempt',
        headers: { 'X-Callback-Token': 'callback-token' },
      },
    });

    expect(body).toMatchObject({
      prompt: 'Fix vulnerable package',
      mode: 'code',
      model: 'kilo-auto/frontier',
      githubRepo: 'Kilo-Org/security-agent-testbed',
      createdOnPlatform: 'security-remediation',
      autoCommit: false,
    });
    expect(body).not.toHaveProperty('upstreamBranch');
  });

  it('instructs Cloud Agent to create and check out the remediation branch after clone', () => {
    const prompt = buildRemediationPrompt({
      finding: {
        repo_full_name: 'Kilo-Org/security-agent-testbed',
        package_name: 'handlebars',
        package_ecosystem: 'npm',
        severity: 'critical',
        dependency_scope: 'runtime',
        cve_id: null,
        ghsa_id: 'GHSA-765h-qjxv-5f44',
        title: 'Prototype Pollution in handlebars',
        vulnerable_version_range: '<4.7.7',
        patched_version: '4.7.7',
        manifest_path: 'package-lock.json',
        analysis: {
          sandboxAnalysis: {
            isExploitable: 'unknown',
            suggestedAction: 'manual_review',
            suggestedFix: 'Upgrade handlebars to 4.7.7.',
            usageLocations: [],
          },
        },
      } as never,
      branchName: 'security-remediation/handlebars-ghsa-765h-qjxv-5f44/b04cabeb31-1',
      findingUrl: 'https://app.kilo.ai/security-agent/findings?findingId=finding-1',
    });

    expect(prompt).toContain(
      'Create and check out branch security-remediation/handlebars-ghsa-765h-qjxv-5f44/b04cabeb31-1 from the current checkout'
    );
  });
});
