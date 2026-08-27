import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resolveGitHubToken } from '../dos/town/town-scm';
import { handleRefreshGitToken } from './refresh-git-token.handler';

vi.mock('../dos/Town.do', () => ({ getTownDOStub: vi.fn() }));
vi.mock('../dos/town/town-scm', () => ({ resolveGitHubToken: vi.fn() }));
vi.mock('../util/jwt.util', () => ({
  verifyContainerJWT: vi.fn(() => ({
    success: true,
    payload: { townId: 'town-1', userId: 'user-1', scope: 'container' },
  })),
}));
vi.mock('../util/secret.util', () => ({ resolveSecret: vi.fn(() => 'test-secret') }));

describe('handleRefreshGitToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes a dotted SSH repository through its exact pinned integration', async () => {
    vi.mocked(getTownDOStub).mockReturnValue({
      getRigConfig: vi.fn().mockResolvedValue({
        gitUrl: 'git@github.com:acme/repo.with.dots.git',
        userId: 'rig-user',
        platformIntegrationId: 'pinned-integration',
      }),
      getTownConfig: vi.fn().mockResolvedValue({
        owner_user_id: 'owner-user',
        organization_id: 'org-1',
      }),
    } as unknown as ReturnType<typeof getTownDOStub>);
    vi.mocked(resolveGitHubToken).mockResolvedValue({
      ok: true,
      token: 'fresh-token',
      source: 'rig platform integration',
    });

    const app = new Hono<GastownEnv>();
    app.post('/refresh', c => handleRefreshGitToken(c, { townId: 'town-1', rigId: 'rig-1' }));

    const response = await app.request(
      '/refresh',
      { method: 'POST', headers: { Authorization: 'Bearer container-token' } },
      {} as Env
    );

    expect(response.status).toBe(200);
    expect(resolveGitHubToken).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/repo.with.dots',
        userId: 'owner-user',
        orgId: 'org-1',
        platformIntegrationId: 'pinned-integration',
      })
    );
  });
});
