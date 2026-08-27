import { afterEach, describe, expect, it } from 'vitest';
import { app } from './control-server';

const originalGitToken = process.env.GIT_TOKEN;

afterEach(() => {
  if (originalGitToken === undefined) delete process.env.GIT_TOKEN;
  else process.env.GIT_TOKEN = originalGitToken;
});

describe('town config git identity', () => {
  it('clears process-global GitHub credentials for rig-scoped identity', async () => {
    process.env.GIT_TOKEN = 'other-rig-token';

    const response = await app.request('/sync-config', {
      method: 'POST',
      headers: {
        'X-Town-Config': JSON.stringify({
          rig_scoped_git_identity: true,
          git_auth: { github_token: 'town-token' },
        }),
      },
    });

    expect(response.status).toBe(200);
    expect(process.env.GIT_TOKEN).toBeUndefined();
  });
});
