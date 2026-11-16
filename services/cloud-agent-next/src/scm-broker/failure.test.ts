import { describe, expect, it } from 'vitest';
import type { EnvironmentReferenceRepository } from '@kilocode/cloud-agent-profile';
import type { GitTokenService } from '../types.js';
import { resolveBuilderGitSource } from '../environment-build/access.js';
import {
  refreshScmCapability,
  type CredentialRepository,
} from '../sandbox-control/session-credentials.js';
import { ScmCapabilityIssueError, scmFailureKind } from './failure.js';

const grant = { userId: 'builder', orgId: 'org-builder', sandboxId: 'ses-' + 'a'.repeat(48) };
const github: CredentialRepository = {
  type: 'github',
  repo: 'acme/widgets',
  authentication: 'managed',
  allowUserAuthorization: false,
};
const gitlab: CredentialRepository = { type: 'gitlab', url: 'https://gitlab.com/acme/widgets.git' };
const bitbucket: CredentialRepository = {
  type: 'bitbucket',
  url: 'https://bitbucket.org/acme/widgets.git',
  workspaceUuid: '{11111111-1111-4111-8111-111111111111}',
  repositoryUuid: '{22222222-2222-4222-8222-222222222222}',
};

async function assertFailure(
  repository: CredentialRepository,
  member: EnvironmentReferenceRepository,
  broker: Partial<GitTokenService>,
  kind: 'denied' | 'transient'
) {
  const env = { GIT_TOKEN_SERVICE: broker as GitTokenService };
  const issue = refreshScmCapability(env, grant, repository, 'allocation-binding', 1000);
  await expect(issue).rejects.toBeInstanceOf(ScmCapabilityIssueError);
  await expect(issue).rejects.toMatchObject({ kind });
  // Pre-allocation authorization and later capability issuance use the same decision.
  expect(
    await resolveBuilderGitSource(env, {
      reference: {
        environmentId: '33333333-3333-4333-8333-333333333333',
        owner: { type: 'organization', id: grant.orgId },
        configurationRevision: 1,
        repository: member.identity,
      },
      member,
      actorUserId: grant.userId,
    })
  ).toEqual({ ok: false, reason: kind === 'denied' ? 'repository_unauthorized' : 'unavailable' });
}

describe('SCM failures survive issuance and build authorization', () => {
  it.each([
    ['repository_not_installed', 'denied'],
    ['database_not_configured', 'transient'],
    ['repository_permissions_unavailable', 'transient'],
  ] as const)('classifies GitHub %s', async (reason, kind) => {
    const refuse = async () => ({ success: false as const, reason });
    await assertFailure(
      github,
      {
        identity: { platform: 'github', repoFullName: 'acme/widgets' },
        repoFullName: 'acme/widgets',
        leaf: 'widgets',
      },
      { issueGitHubSessionCapability: refuse, getCloudAgentAuthForRepo: refuse },
      kind
    );
  });

  it.each([
    ['no_matching_integration', 'denied'],
    ['token_refresh_failed', 'transient'],
    ['project_lookup_failed', 'transient'],
  ] as const)('classifies GitLab %s', async (reason, kind) => {
    const refuse = async () => ({ success: false as const, reason });
    await assertFailure(
      gitlab,
      {
        identity: { platform: 'gitlab', cloneUrl: gitlab.url },
        repoFullName: 'acme/widgets',
        leaf: 'widgets',
      },
      { issueGitLabSessionCapability: refuse, getGitLabToken: refuse },
      kind
    );
  });

  it.each([
    ['insufficient_permissions', 'denied'],
    ['temporarily_unavailable', 'transient'],
  ] as const)('classifies Bitbucket %s', async (reason, kind) => {
    const refuse = async () => ({ success: false as const, reason });
    await assertFailure(
      bitbucket,
      {
        identity: {
          platform: 'bitbucket',
          workspaceUuid: bitbucket.workspaceUuid,
          repositoryUuid: bitbucket.repositoryUuid,
        },
        repoFullName: 'acme/widgets',
        leaf: 'widgets',
      },
      { issueBitbucketSessionCapability: refuse, getBitbucketToken: refuse },
      kind
    );
  });

  it('preserves a refusal from GitHub association authorization before issuance', async () => {
    const env = {
      GIT_TOKEN_SERVICE: {
        authorizeCloudAgentGitHubRepo: async () => ({
          success: false,
          reason: 'integration_mismatch',
        }),
      } as unknown as GitTokenService,
    };
    await expect(
      refreshScmCapability(
        env,
        grant,
        { ...github, expectedIntegrationId: 'installation-1' },
        'allocation-binding',
        1000
      )
    ).rejects.toMatchObject({ kind: 'denied' });
  });

  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'keeps %s transport and unknown failures retryable',
    platform => {
      expect(scmFailureKind(platform, 'rpc_error')).toBe('transient');
      expect(scmFailureKind(platform, 'new_broker_failure')).toBe('transient');
    }
  );
});
