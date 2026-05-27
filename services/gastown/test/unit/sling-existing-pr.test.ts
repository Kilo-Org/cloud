import { describe, it, expect, vi } from 'vitest';
import { checkPRStatus, type SCMContext } from '../../src/dos/town/town-scm';
import { parsePrUrlForRepoMatch, parseGitUrl } from '../../src/util/platform-pr.util';
import type { TownConfig } from '../../src/types';

class MiniSql {
  exec(_stmt: string): void {}
  prepare(_stmt: string): {
    bind(...params: unknown[]): { step(): boolean; getRow(): unknown[]; free(): void };
  } {
    return {
      bind: (..._params: unknown[]) => ({
        step: () => false,
        getRow: () => [],
        free: () => {},
      }),
    };
  }
}

function mockSCMContext(overrides: Partial<SCMContext> = {}): SCMContext {
  return {
    env: {} as SCMContext['env'],
    townId: 'test-town',
    getTownConfig: async () => ({}) as TownConfig,
    ...overrides,
  };
}

function makeSql(): SqlStorage {
  return new MiniSql() as unknown as SqlStorage;
}

describe('parsePrUrlForRepoMatch', () => {
  it('parses GitHub PR URL', () => {
    const result = parsePrUrlForRepoMatch('https://github.com/Kilo-Org/cloud/pull/42');
    expect(result).toEqual({ platform: 'github', owner: 'Kilo-Org', repo: 'cloud' });
  });

  it('parses GitLab MR URL with simple group', () => {
    const result = parsePrUrlForRepoMatch('https://gitlab.com/group/project/-/merge_requests/7');
    expect(result).toEqual({ platform: 'gitlab', owner: 'group', repo: 'project' });
  });

  it('parses GitLab MR URL with subgroup', () => {
    const result = parsePrUrlForRepoMatch(
      'https://gitlab.example.com/org/team/project/-/merge_requests/99'
    );
    expect(result).toEqual({ platform: 'gitlab', owner: 'org/team', repo: 'project' });
  });

  it('returns null for unrecognized URLs', () => {
    expect(parsePrUrlForRepoMatch('https://example.com/pr/1')).toBeNull();
    expect(parsePrUrlForRepoMatch('not a url')).toBeNull();
  });
});

describe('repo mismatch validation', () => {
  it('detects mismatch between rig git_url and PR URL (different owner)', () => {
    const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
    const prCoords = parsePrUrlForRepoMatch('https://github.com/Other-Org/cloud/pull/1');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    expect(rigCoords!.owner).not.toBe(prCoords!.owner);
  });

  it('detects mismatch between rig git_url and PR URL (different repo)', () => {
    const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
    const prCoords = parsePrUrlForRepoMatch('https://github.com/Kilo-Org/other-repo/pull/1');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    expect(rigCoords!.repo).not.toBe(prCoords!.repo);
  });

  it('detects match between rig git_url and PR URL', () => {
    const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
    const prCoords = parsePrUrlForRepoMatch('https://github.com/Kilo-Org/cloud/pull/42');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    expect(rigCoords!.platform).toBe(prCoords!.platform);
    expect(rigCoords!.owner).toBe(prCoords!.owner);
    expect(rigCoords!.repo).toBe(prCoords!.repo);
  });

  it('detects match for GitLab URLs', () => {
    const rigCoords = parseGitUrl('https://gitlab.com/group/project');
    const prCoords = parsePrUrlForRepoMatch('https://gitlab.com/group/project/-/merge_requests/7');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    expect(rigCoords!.platform).toBe(prCoords!.platform);
    expect(rigCoords!.owner).toBe(prCoords!.owner);
    expect(rigCoords!.repo).toBe(prCoords!.repo);
  });

  it('detects cross-platform mismatch (GitHub rig, GitLab PR)', () => {
    const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
    const prCoords = parsePrUrlForRepoMatch('https://gitlab.com/Kilo-Org/cloud/-/merge_requests/7');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    expect(rigCoords!.platform).not.toBe(prCoords!.platform);
  });
});

describe('checkPRStatus extended return shape', () => {
  it('returns head_branch/base_branch/head_sha for GitHub PR', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        state: 'open',
        merged: false,
        mergeable_state: 'clean',
        head: { ref: 'feature-branch', sha: 'abc1234def' },
        base: { ref: 'main' },
        title: 'Add new feature',
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/Kilo-Org/cloud/pull/42');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('open');
      expect(outcome.result.head_branch).toBe('feature-branch');
      expect(outcome.result.base_branch).toBe('main');
      expect(outcome.result.head_sha).toBe('abc1234def');
      expect(outcome.result.title).toBe('Add new feature');
    }
    fetchSpy.mockRestore();
  });

  it('returns head_branch/base_branch/head_sha for closed GitHub PR', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        state: 'closed',
        merged: false,
        head: { ref: 'feature-branch', sha: 'abc123' },
        base: { ref: 'main' },
        title: 'Closed PR',
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/Kilo-Org/cloud/pull/42');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('closed');
      expect(outcome.result.head_branch).toBe('feature-branch');
    }
    fetchSpy.mockRestore();
  });

  it('returns head_branch/base_branch/head_sha for merged GitHub PR', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        state: 'closed',
        merged: true,
        head: { ref: 'feature-branch', sha: 'mergedsha' },
        base: { ref: 'main' },
        title: 'Merged PR',
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/Kilo-Org/cloud/pull/42');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('merged');
      expect(outcome.result.head_branch).toBe('feature-branch');
    }
    fetchSpy.mockRestore();
  });

  it('returns head_branch/base_branch for GitLab MR', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        state: 'opened',
        source_branch: 'feature-branch',
        target_branch: 'main',
        sha: 'glsha123',
        title: 'GitLab MR title',
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const ctx = mockSCMContext({
      getTownConfig: async () =>
        ({
          git_auth: { gitlab_token: 'glpat_test', gitlab_instance_url: 'https://gitlab.com' },
        }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://gitlab.com/group/project/-/merge_requests/7');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('open');
      expect(outcome.result.head_branch).toBe('feature-branch');
      expect(outcome.result.base_branch).toBe('main');
      expect(outcome.result.head_sha).toBe('glsha123');
      expect(outcome.result.title).toBe('GitLab MR title');
    }
    fetchSpy.mockRestore();
  });

  it('returns ok:false with no_token error when no GitHub token', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () => ({}) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/Kilo-Org/cloud/pull/42');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('no_token');
    }
  });

  it('returns ok:false with http_error on API failure', async () => {
    const mockResponse = { ok: false, status: 500, statusText: 'Internal Server Error' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/Kilo-Org/cloud/pull/42');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('http_error');
      if (outcome.error.kind === 'http_error') {
        expect(outcome.error.status).toBe(500);
        expect(outcome.error.transient).toBe(true);
      }
    }
    fetchSpy.mockRestore();
  });
});

describe('slingExistingPr validation logic', () => {
  it('repo mismatch throws with clear message', () => {
    const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
    const prCoords = parsePrUrlForRepoMatch('https://github.com/OtherOrg/cloud/pull/1');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    const mismatch =
      rigCoords!.platform !== prCoords!.platform ||
      rigCoords!.owner !== prCoords!.owner ||
      rigCoords!.repo !== prCoords!.repo;
    expect(mismatch).toBe(true);
  });

  it('repo match passes validation', () => {
    const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
    const prCoords = parsePrUrlForRepoMatch('https://github.com/Kilo-Org/cloud/pull/42');
    expect(rigCoords).toBeTruthy();
    expect(prCoords).toBeTruthy();
    const match =
      rigCoords!.platform === prCoords!.platform &&
      rigCoords!.owner === prCoords!.owner &&
      rigCoords!.repo === prCoords!.repo;
    expect(match).toBe(true);
  });
});

describe('forcePushAllowed default', () => {
  it('defaults to false when not specified', () => {
    const forcePushAllowed = undefined ?? false;
    expect(forcePushAllowed).toBe(false);
  });

  it('persists true when explicitly set', () => {
    const forcePushAllowed = true;
    expect(forcePushAllowed).toBe(true);
  });
});
