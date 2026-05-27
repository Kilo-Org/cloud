import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

import { GitHubTokenService } from './github-token-service.js';
import { GitTokenRPCEntrypoint } from './index.js';
import { InstallationLookupService } from './installation-lookup-service.js';

describe('GitTokenRPCEntrypoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('mints repository-scoped tokens after resolving an authorized installation', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'lite',
    });
    const getTokenForRepo = vi
      .spyOn(GitHubTokenService.prototype, 'getTokenForRepo')
      .mockResolvedValue('scoped-token');
    const getToken = vi
      .spyOn(GitHubTokenService.prototype, 'getToken')
      .mockResolvedValue('installation-wide-token');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: true,
      token: 'scoped-token',
      installationId: '123',
      accountLogin: 'old-owner',
      appType: 'lite',
    });
    expect(getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'lite');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('repairs stale login metadata after a lookup miss before minting a token', async () => {
    const findInstallationId = vi
      .spyOn(InstallationLookupService.prototype, 'findInstallationId')
      .mockResolvedValueOnce({ success: false, reason: 'no_installation_found' })
      .mockResolvedValueOnce({
        success: true,
        installationId: '123',
        accountLogin: 'renamed-owner',
        githubAppType: 'standard',
      });
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    const updateAccountLogin = vi
      .spyOn(InstallationLookupService.prototype, 'updateAccountLogin')
      .mockResolvedValue(true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(
      GitHubTokenService.prototype,
      'refreshInstallationAccountLoginIfDue'
    ).mockResolvedValue('renamed-owner');
    const getTokenForRepo = vi
      .spyOn(GitHubTokenService.prototype, 'getTokenForRepo')
      .mockResolvedValue('scoped-token');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toMatchObject({ success: true, token: 'scoped-token' });
    expect(updateAccountLogin).toHaveBeenCalledWith('integration-1', 'renamed-owner');
    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'Repaired GitHub installation account login after token lookup miss',
        integrationId: 'integration-1',
        installationId: '123',
        appType: 'standard',
      })
    );
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('old-owner');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('renamed-owner');
    expect(findInstallationId).toHaveBeenCalledTimes(2);
    expect(getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'standard');
  });

  it('warns instead of reporting success when a repaired integration no longer exists', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    vi.spyOn(InstallationLookupService.prototype, 'updateAccountLogin').mockResolvedValue(false);
    vi.spyOn(
      GitHubTokenService.prototype,
      'refreshInstallationAccountLoginIfDue'
    ).mockResolvedValue('renamed-owner');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'GitHub installation login repair found no integration row to update',
        integrationId: 'integration-1',
        installationId: '123',
        appType: 'standard',
      })
    );
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('old-owner');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('renamed-owner');
  });

  it('does not mint when refreshed metadata identifies a different repository owner', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    const updateAccountLogin = vi
      .spyOn(InstallationLookupService.prototype, 'updateAccountLogin')
      .mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(
      GitHubTokenService.prototype,
      'refreshInstallationAccountLoginIfDue'
    ).mockResolvedValue('different-owner');
    const getTokenForRepo = vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(updateAccountLogin).toHaveBeenCalledWith('integration-1', 'different-owner');
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('fails closed without metadata repair when exact owner selection is ambiguous', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });
    const findRefreshCandidates = vi.spyOn(
      InstallationLookupService.prototype,
      'findRefreshCandidates'
    );
    const getTokenForRepo = vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(findRefreshCandidates).not.toHaveBeenCalled();
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not mint a token for an invalid repository path', async () => {
    const getTokenForRepo = vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo');
    const rpc = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      {
        HYPERDRIVE: { connectionString: 'postgres://test' },
      } as CloudflareEnv
    );

    const result = await rpc.getTokenForRepo({
      githubRepo: 'owner/repository/extra',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'invalid_repo_format' });
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not fall back to an installation-wide token when scoped minting fails', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'standard',
    });
    vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo').mockRejectedValue(
      new Error('repository not accessible')
    );
    const getToken = vi.spyOn(GitHubTokenService.prototype, 'getToken');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    await expect(
      rpc.getTokenForRepo({ githubRepo: 'renamed-owner/repository', userId: 'user-1' })
    ).rejects.toThrow('repository not accessible');
    expect(getToken).not.toHaveBeenCalled();
  });
});
