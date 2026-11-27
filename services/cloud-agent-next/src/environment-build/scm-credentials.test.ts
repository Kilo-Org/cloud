import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentReferenceRepository } from '@kilocode/cloud-agent-profile';
import type { Env } from '../types.js';
import {
  issueBuildScmGrant,
  resolveBuildScmCredential,
  buildScmGrantSchema,
} from './scm-credentials.js';

const member = (repoFullName: string): EnvironmentReferenceRepository => ({
  identity: { platform: 'github', repoFullName },
  repoFullName,
  leaf: repoFullName.split('/')[1]!,
});
function fixture() {
  const issue = vi.fn(async () => ({
    success: true as const,
    capability: 'kgh2.synthetic-build',
    source: 'installation' as const,
    installationId: '123',
    appType: 'standard' as const,
  }));
  const env = { GIT_TOKEN_SERVICE: { issueGitHubSessionCapability: issue } } as unknown as Pick<
    Env,
    'GIT_TOKEN_SERVICE'
  >;
  return {
    issue,
    input: {
      env,
      provider: 'aws-ec2' as const,
      owner: {
        environmentId: '11111111-1111-4111-8111-111111111111',
        buildId: '22222222-2222-4222-8222-222222222222',
        allocationId: '33333333-3333-4333-8333-333333333333',
        sandboxId: 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
        userId: 'user-builder',
        orgId: 'org-builder',
      },
      members: [member('acme/one'), member('acme/two')],
      now: 1000,
      deadlineAt: 1_801_000,
    },
  };
}

describe('EC2 environment builder SCM issuance', () => {
  it('issues only workflow authority and shares a stable alias across same-provider repositories', async () => {
    const f = fixture();
    const grant = await issueBuildScmGrant(f.input);
    expect(grant).not.toHaveProperty('kilo');
    expect(grant).not.toHaveProperty('members');
    expect(grant.scm.alias).toMatch(/^kcp/);
    expect(grant.additionalRepositories?.[0].scm.alias).toBe(grant.scm.alias);
    expect(f.issue.mock.calls).toEqual(
      f.input.members.map(member => [
        {
          userId: f.input.owner.userId,
          orgId: f.input.owner.orgId,
          githubRepo: member.repoFullName,
          accessPurpose: 'workflow',
          allowUserAuthorization: false,
          outboundContainerId: grant.outboundContainerId,
        },
      ])
    );
    expect(grant.expiresAt).toBe(f.input.deadlineAt);
  });

  it('issues the other repositories together after the launch repository', async () => {
    const f = fixture();
    f.input.members.push(member('acme/three'));
    const issued = f.issue.getMockImplementation()!;
    let inFlight = 0;
    let peak = 0;
    f.issue.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return issued();
    });
    const grant = await issueBuildScmGrant(f.input);
    expect(f.issue).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);
    expect(grant.repository).toMatchObject({ repo: 'acme/one' });
    expect(grant.additionalRepositories?.map(entry => entry.repository)).toMatchObject([
      { repo: 'acme/two' },
      { repo: 'acme/three' },
    ]);
  });

  it('fails the whole grant when one repository cannot be issued', async () => {
    const f = fixture();
    f.issue.mockImplementationOnce(f.issue.getMockImplementation()!);
    f.issue.mockRejectedValueOnce(new Error('synthetic issuance failure'));
    await expect(issueBuildScmGrant(f.input)).rejects.toThrow(
      'Environment repository credential is unavailable'
    );
  });

  it('refuses engine substitution in persisted broker authority', async () => {
    const f = fixture();
    const grant = await issueBuildScmGrant(f.input);
    expect(buildScmGrantSchema.safeParse({ ...grant, provider: 'aws' }).success).toBe(false);
  });

  it('renews the selected member and preserves every alias', async () => {
    const f = fixture();
    const grant = await issueBuildScmGrant(f.input);
    grant.additionalRepositories![0].scm.capability!.expiresAt = 1500;
    f.issue.mockClear();
    const result = await resolveBuildScmCredential({
      env: f.input.env,
      grant,
      credential: grant.scm.alias!,
      url: 'https://api.github.com/repos/acme/two/issues',
      outboundContainerId: grant.outboundContainerId,
      now: 2000,
    });
    expect(result?.credential).toBe('kgh2.synthetic-build');
    expect(f.issue).toHaveBeenCalledOnce();
    expect(f.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/two',
        accessPurpose: 'workflow',
        allowUserAuthorization: false,
      })
    );
    expect(result?.grant.scm.alias).toBe(grant.scm.alias);
    expect(result?.grant.additionalRepositories?.[0].scm.alias).toBe(grant.scm.alias);
  });

  it.each(['expired', 'binding', 'alias', 'raw-token', 'workflow', 'user-fallback'])(
    'rejects %s authority before renewal',
    async change => {
      const f = fixture();
      const grant = await issueBuildScmGrant(f.input);
      f.issue.mockClear();
      let now = 2000;
      if (change === 'expired') now = grant.expiresAt;
      if (change === 'binding') grant.outboundContainerId = 'other';
      if (change === 'alias') grant.scm.alias = grant.scm.alias?.replace('github', 'gitlab');
      if (change === 'raw-token') grant.scm.nativeToken = 'synthetic-raw-token';
      if (grant.repository.type === 'github') {
        if (change === 'workflow') grant.repository.accessPurpose = 'agent';
        if (change === 'user-fallback') grant.repository.allowUserAuthorization = true;
      }
      expect(
        await resolveBuildScmCredential({
          env: f.input.env,
          grant,
          credential: grant.scm.alias!,
          url: 'https://github.com/acme/one.git',
          outboundContainerId: grant.outboundContainerId,
          now,
        })
      ).toBeNull();
      expect(f.issue).not.toHaveBeenCalled();
    }
  );

  it('rejects unsupported GitLab hosts before any issuance', async () => {
    const f = fixture();
    f.input.members.push({
      identity: { platform: 'gitlab', cloneUrl: 'https://private.example.com/team/repo.git' },
      repoFullName: 'team/repo',
      leaf: 'repo',
    });
    await expect(issueBuildScmGrant(f.input)).rejects.toThrow('supported public host');
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('rejects injected session or model state in persisted build grants', async () => {
    const grant = await issueBuildScmGrant(fixture().input);
    expect(buildScmGrantSchema.safeParse({ ...grant, kilo: { token: 'synthetic' } }).success).toBe(
      false
    );
  });
});
