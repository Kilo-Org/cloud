import { describe, expect, it } from 'vitest';
import { buildRemediationPrepareSessionBody, buildRemediationPrompt } from './remediation.js';

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
