import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshGitToken } from './git-manager';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('refreshGitToken', () => {
  it('refreshes one rig without replacing another rig token in process.env', async () => {
    process.env.GASTOWN_API_URL = 'https://gastown.example.com';
    process.env.GASTOWN_TOWN_ID = 'town-1';
    process.env.GASTOWN_CONTAINER_TOKEN = 'container-token';
    process.env.GIT_TOKEN = 'other-rig-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ success: true, data: { token: 'rig-one-token' } }))
    );

    await expect(refreshGitToken('rig-one')).resolves.toBe('rig-one-token');
    expect(process.env.GIT_TOKEN).toBe('other-rig-token');
  });
});
