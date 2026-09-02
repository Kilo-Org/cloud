import { describe, expect, it, vi } from 'vitest';
import {
  allowsDirectGithubToken,
  GithubTokenResolutionError,
  resolveGithubCredentials,
  resolveGithubToken,
} from '../../src/github-token';
import type { GitTokenService, StartReviewInput } from '../../src/types';

const input: StartReviewInput = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  userId: 'user-1',
  organizationId: 'org-1',
  kiloToken: 'kilo-token',
};

function serviceWith(result: Awaited<ReturnType<GitTokenService['getTokenForRepo']>>) {
  return {
    getTokenForRepo: vi.fn().mockResolvedValue(result),
  } satisfies GitTokenService;
}

describe('GitHub credential identity', () => {
  it('preserves installation/app identity and forwards the exact integration fence', async () => {
    const service = serviceWith({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });
    await expect(
      resolveGithubCredentials({
        input: {
          ...input,
          expectedIntegrationId: 'integration-1',
          expectedInstallationId: '123',
          expectedAppType: 'standard',
        },
        service,
        allowDirectToken: false,
      })
    ).resolves.toEqual({ token: 'installation-token', installationId: '123', appType: 'standard' });
    expect(service.getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/widget',
      userId: 'user-1',
      orgId: 'org-1',
      expectedIntegrationId: 'integration-1',
    });
  });

  it.each([undefined, '   '])(
    'pins personal prepared identity without the organization-only integration parameter',
    async organizationId => {
      const service = {
        getTokenForRepo: vi.fn(
          async (params: Parameters<GitTokenService['getTokenForRepo']>[0]) => {
            if (params.expectedIntegrationId !== undefined && params.orgId === undefined) {
              return { success: false, reason: 'integration_mismatch' } as const;
            }
            return {
              success: true,
              token: 'personal-token',
              installationId: '123',
              appType: 'standard',
              accountLogin: 'acme',
            } as const;
          }
        ),
      } satisfies GitTokenService;
      await expect(
        resolveGithubCredentials({
          input: {
            ...input,
            organizationId,
            expectedIntegrationId: 'personal-integration',
            expectedInstallationId: '123',
            expectedAppType: 'standard',
          },
          service,
          allowDirectToken: false,
        })
      ).resolves.toEqual({ token: 'personal-token', installationId: '123', appType: 'standard' });
      expect(service.getTokenForRepo).toHaveBeenCalledWith({
        githubRepo: 'acme/widget',
        userId: 'user-1',
      });
    }
  );

  it.each([{ expectedInstallationId: 'different' }, { expectedAppType: 'lite' as const }])(
    'still rejects personal prepared installation or app mismatches',
    async mismatch => {
      const service = serviceWith({
        success: true,
        token: 'personal-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      });
      await expect(
        resolveGithubCredentials({
          input: {
            ...input,
            organizationId: undefined,
            expectedIntegrationId: 'personal-integration',
            expectedInstallationId: '123',
            expectedAppType: 'standard',
            ...mismatch,
          },
          service,
          allowDirectToken: false,
        })
      ).rejects.toThrow('does not match');
      expect(service.getTokenForRepo).toHaveBeenCalledWith({
        githubRepo: 'acme/widget',
        userId: 'user-1',
      });
    }
  );

  it.each(['expectedInstallationId', 'expectedAppType'] as const)(
    'does not drop a personal integration fence without %s',
    async field => {
      const service = serviceWith({
        success: true,
        token: 'personal-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      });
      await expect(
        resolveGithubCredentials({
          input: {
            ...input,
            organizationId: undefined,
            expectedIntegrationId: 'personal-integration',
            expectedInstallationId: '123',
            expectedAppType: 'standard',
            [field]: undefined,
          },
          service,
          allowDirectToken: false,
        })
      ).rejects.toThrow('Personal prepared reviews require installation and app identity');
      expect(service.getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it.each([{ expectedInstallationId: 'different' }, { expectedAppType: 'lite' as const }])(
    'rejects prepared identity mismatches without fallback',
    async expected => {
      const service = serviceWith({
        success: true,
        token: 'installation-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      });
      await expect(
        resolveGithubCredentials({
          input: { ...input, ...expected, dryRun: true },
          service,
          allowDirectToken: false,
        })
      ).rejects.toThrow('does not match');
      expect(service.getTokenForRepo).toHaveBeenCalledOnce();
    }
  );

  it.each([
    undefined,
    { success: true, token: '', installationId: '123', appType: 'standard' },
    { success: true, token: 'fixture-token', appType: 'standard' },
    { success: true, token: 'fixture-token', installationId: '123', appType: 'unknown' },
    { success: false, reason: 'unexpected secret-bearing failure' },
  ])('rejects malformed unowned RPC output without echoing it', async result => {
    const service = { getTokenForRepo: vi.fn().mockResolvedValue(result) };
    await expect(
      resolveGithubCredentials({ input, service, allowDirectToken: false })
    ).rejects.toThrow('returned invalid credentials or identity');
  });

  it('does not expose an RPC exception containing credentials', async () => {
    const service = { getTokenForRepo: vi.fn().mockRejectedValue(new Error('fixture-secret')) };
    await expect(
      resolveGithubCredentials({ input, service, allowDirectToken: false })
    ).rejects.toThrow('git-token-service RPC failed');
  });

  it.each([
    {
      result: {
        success: true,
        token: 'fixture-token',
        installationId: '123',
        appType: 'standard',
      },
      error: undefined,
    },
    {
      result: { success: false, reason: 'repository_not_installed' },
      error: 'repository_not_installed',
    },
    {
      result: { success: true, token: 'fixture-token', appType: 'standard' },
      error: 'returned invalid credentials or identity',
    },
    {
      result: {
        success: true,
        token: 'fixture-token',
        installationId: '456',
        appType: 'standard',
      },
      error: 'installation does not match',
    },
    {
      result: {
        success: true,
        token: 'fixture-token',
        installationId: '123',
        appType: 'lite',
      },
      error: 'GitHub Lite installations cannot publish reviews',
    },
  ])('disposes the unowned RPC result after validation: $error', async ({ result, error }) => {
    const dispose = vi.fn();
    const rawResult = { ...result, [Symbol.dispose]: dispose };
    const service = { getTokenForRepo: vi.fn().mockResolvedValue(rawResult) };
    const resolution = resolveGithubCredentials({
      input: { ...input, expectedInstallationId: '123', dryRun: false },
      service,
      allowDirectToken: false,
    });
    if (error) await expect(resolution).rejects.toThrow(error);
    else
      await expect(resolution).resolves.toEqual({
        token: 'fixture-token',
        installationId: '123',
        appType: 'standard',
      });
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.contexts).toEqual([rawResult]);
  });

  it('sanitizes a failed RPC disposer without exposing its credential-bearing error', async () => {
    const dispose = vi.fn(() => {
      throw new Error('fixture-secret');
    });
    const service = {
      getTokenForRepo: vi.fn().mockResolvedValue({
        success: true,
        token: 'fixture-token',
        installationId: '123',
        appType: 'standard',
        [Symbol.dispose]: dispose,
      }),
    };
    await expect(
      resolveGithubCredentials({ input, service, allowDirectToken: false })
    ).rejects.toMatchObject({
      name: 'GithubTokenResolutionError',
      message: 'GitHub token unavailable: git-token-service RPC failed',
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns explicitly absent fixture identity rather than inventing one', async () => {
    await expect(
      resolveGithubCredentials({
        input: { ...input, gitToken: 'fixture-token' },
        allowDirectToken: true,
      })
    ).resolves.toEqual({ token: 'fixture-token' });
  });

  it('does not let a direct fixture token satisfy a prepared installation assertion', async () => {
    await expect(
      resolveGithubCredentials({
        input: { ...input, gitToken: 'fixture-token', expectedInstallationId: '123' },
        allowDirectToken: true,
      })
    ).rejects.toThrow('cannot prove installation identity');
  });
});

describe('GitHub token resolution', () => {
  it('mints a repo-scoped standard installation token for live reviews', async () => {
    const service = serviceWith({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    await expect(
      resolveGithubToken({ input: { ...input, dryRun: false }, service, allowDirectToken: false })
    ).resolves.toBe('installation-token');
    expect(service.getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/widget',
      userId: 'user-1',
      orgId: 'org-1',
    });
  });

  it('rejects read-only GitHub Lite installations before live reviews can start', async () => {
    const service = serviceWith({
      success: true,
      token: 'lite-installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'lite',
    });

    await expect(
      resolveGithubToken({ input: { ...input, dryRun: false }, service, allowDirectToken: false })
    ).rejects.toEqual(
      expect.objectContaining({
        name: GithubTokenResolutionError.name,
        reason: 'GitHub Lite installations cannot publish reviews',
      })
    );
  });

  it.each([true, undefined])('allows GitHub Lite installations with dryRun=%s', async dryRun => {
    const service = serviceWith({
      success: true,
      token: 'lite-installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'lite',
    });

    await expect(
      resolveGithubToken({ input: { ...input, dryRun }, service, allowDirectToken: false })
    ).resolves.toBe('lite-installation-token');
  });

  it('surfaces the service lookup reason without exposing credentials', async () => {
    const service = serviceWith({ success: false, reason: 'repository_not_installed' });

    await expect(resolveGithubToken({ input, service, allowDirectToken: false })).rejects.toEqual(
      expect.objectContaining({
        name: GithubTokenResolutionError.name,
        reason: 'repository_not_installed',
      })
    );
  });

  it('rejects a missing service binding for an identified user', async () => {
    await expect(resolveGithubToken({ input, allowDirectToken: false })).rejects.toThrow(
      'git-token-service binding is not configured'
    );
  });

  it('allows direct credentials only when explicitly enabled for offline fixtures', async () => {
    const directInput = {
      ...input,
      userId: undefined,
      organizationId: undefined,
      gitToken: 'fixture-token',
    };

    await expect(resolveGithubToken({ input: directInput, allowDirectToken: true })).resolves.toBe(
      'fixture-token'
    );
    await expect(
      resolveGithubToken({ input: directInput, allowDirectToken: false })
    ).rejects.toThrow('direct GitHub tokens are disabled in production');
  });

  it('prefers the direct fixture token over service resolution in test environments', async () => {
    const service = serviceWith({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    await expect(
      resolveGithubToken({
        input: { ...input, gitToken: 'fixture-token' },
        service,
        allowDirectToken: true,
      })
    ).resolves.toBe('fixture-token');
    expect(service.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('treats only non-production environments as fixture-enabled', () => {
    expect(allowsDirectGithubToken('production')).toBe(false);
    expect(allowsDirectGithubToken('test')).toBe(true);
    expect(allowsDirectGithubToken(undefined)).toBe(false);
  });
});
