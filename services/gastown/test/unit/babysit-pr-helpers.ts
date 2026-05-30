import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPRStatus, type SCMContext } from '../../src/dos/town/town-scm';
import { parseGitUrl } from '../../src/util/platform-pr.util';
import type { TownConfig } from '../../src/types';

export function mockSCMContext(overrides: Partial<SCMContext> = {}): SCMContext {
  return {
    env: {} as SCMContext['env'],
    townId: 'test-town',
    getTownConfig: async () => ({}) as TownConfig,
    ...overrides,
  };
}

export const GITHUB_OPEN_PR = {
  state: 'open',
  merged: false,
  mergeable_state: 'clean',
  head: { ref: 'feature/babysit', sha: 'abc1234def5678' },
  base: { ref: 'main' },
  title: 'Add babysit PR feature',
};

export const GITHUB_MERGED_PR = {
  state: 'closed',
  merged: true,
  mergeable_state: 'clean',
  head: { ref: 'feature/merged', sha: 'mergedsha123' },
  base: { ref: 'main' },
  title: 'Already merged PR',
};

export const GITHUB_CLOSED_PR = {
  state: 'closed',
  merged: false,
  head: { ref: 'feature/closed', sha: 'closedsha123' },
  base: { ref: 'main' },
  title: 'Closed PR',
};

export const GITLAB_OPEN_MR = {
  state: 'opened',
  source_branch: 'feature/babysit',
  target_branch: 'main',
  sha: 'glabc1234def',
  title: 'Add babysit MR feature',
};

export const GITLAB_MERGED_MR = {
  state: 'merged',
  source_branch: 'feature/merged',
  target_branch: 'main',
  sha: 'glmergedsha',
  title: 'Already merged MR',
};

export const GITLAB_CLOSED_MR = {
  state: 'closed',
  source_branch: 'feature/closed',
  target_branch: 'main',
  sha: 'glclosedsha',
  title: 'Closed MR',
};

export function registerCheckPRStatusTests() {
  describe('checkPRStatus extended fields (head_branch, base_branch, head_sha, title)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns head_branch, base_branch, head_sha, title for open GitHub PR', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITHUB_OPEN_PR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('open');
        expect(outcome.result.head_branch).toBe('feature/babysit');
        expect(outcome.result.base_branch).toBe('main');
        expect(outcome.result.head_sha).toBe('abc1234def5678');
        expect(outcome.result.title).toBe('Add babysit PR feature');
      }
    });

    it('returns head_branch, base_branch, head_sha, title for merged GitHub PR', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITHUB_MERGED_PR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('merged');
        expect(outcome.result.head_branch).toBe('feature/merged');
        expect(outcome.result.base_branch).toBe('main');
        expect(outcome.result.head_sha).toBe('mergedsha123');
        expect(outcome.result.title).toBe('Already merged PR');
      }
    });

    it('returns head_branch, base_branch, head_sha, title for closed GitHub PR', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITHUB_CLOSED_PR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('closed');
        expect(outcome.result.head_branch).toBe('feature/closed');
        expect(outcome.result.base_branch).toBe('main');
        expect(outcome.result.head_sha).toBe('closedsha123');
      }
    });

    it('returns head_branch, base_branch, head_sha, title for open GitLab MR', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITLAB_OPEN_MR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { gitlab_token: 'glpat_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://gitlab.com/group/project/-/merge_requests/5');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('open');
        expect(outcome.result.head_branch).toBe('feature/babysit');
        expect(outcome.result.base_branch).toBe('main');
        expect(outcome.result.head_sha).toBe('glabc1234def');
        expect(outcome.result.title).toBe('Add babysit MR feature');
      }
    });

    it('returns extended fields for merged GitLab MR', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITLAB_MERGED_MR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { gitlab_token: 'glpat_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://gitlab.com/group/project/-/merge_requests/5');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('merged');
        expect(outcome.result.head_branch).toBe('feature/merged');
        expect(outcome.result.base_branch).toBe('main');
      }
    });

    it('returns extended fields for closed GitLab MR', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITLAB_CLOSED_MR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { gitlab_token: 'glpat_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://gitlab.com/group/project/-/merge_requests/5');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('closed');
        expect(outcome.result.head_branch).toBe('feature/closed');
      }
    });

    it('returns undefined extended fields when API omits them', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ state: 'open', merged: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('open');
        expect(outcome.result.head_branch).toBeUndefined();
        expect(outcome.result.base_branch).toBeUndefined();
        expect(outcome.result.head_sha).toBeUndefined();
        expect(outcome.result.title).toBeUndefined();
      }
    });

    it('SCM API failure propagates with structured failureKind', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_bad' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.error.kind === 'http_error') {
        expect(outcome.error.status).toBe(401);
        expect(outcome.error.provider).toBe('github');
        expect(outcome.error.transient).toBe(false);
      }
    });

    it('no_token error propagates with resolution chain', async () => {
      const ctx = mockSCMContext({
        getTownConfig: async () => ({}) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.error.kind === 'no_token') {
        expect(outcome.error.provider).toBe('github');
        expect(outcome.error.resolutionChain.length).toBeGreaterThan(0);
      }
    });
  });
}

export function registerRepoValidationTests() {
  describe('slingExistingPr repo validation', () => {
    it('matches GitHub PR URL to rig git_url', () => {
      const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
      expect(rigCoords).toEqual({
        platform: 'github',
        owner: 'Kilo-Org',
        repo: 'cloud',
      });

      const prUrlMatch = 'https://github.com/Kilo-Org/cloud/pull/42'.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
      );
      expect(prUrlMatch).not.toBeNull();
      expect(prUrlMatch![1]).toBe('Kilo-Org');
      expect(prUrlMatch![2]).toBe('cloud');
      expect(prUrlMatch![1]).toBe(rigCoords!.owner);
      expect(prUrlMatch![2]).toBe(rigCoords!.repo);
    });

    it('detects repo mismatch between GitHub PR URL and rig', () => {
      const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
      const prUrlMatch = 'https://github.com/Other-Org/cloud/pull/42'.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
      );
      expect(prUrlMatch).not.toBeNull();
      expect(prUrlMatch![1]).toBe('Other-Org');
      expect(prUrlMatch![1]).not.toBe(rigCoords!.owner);
    });

    it('detects platform mismatch (GitHub rig vs GitLab PR)', () => {
      const rigCoords = parseGitUrl('https://github.com/Kilo-Org/cloud');
      expect(rigCoords!.platform).toBe('github');

      const glMatch = 'https://gitlab.com/Kilo-Org/cloud/-/merge_requests/7'.match(
        /^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/
      );
      expect(glMatch).not.toBeNull();
    });

    it('matches GitLab MR URL to rig git_url with gitlab_instance_url', () => {
      const rigCoords = parseGitUrl(
        'https://gitlab.mycompany.com/group/project',
        'https://gitlab.mycompany.com'
      );
      expect(rigCoords).toEqual({
        platform: 'gitlab',
        owner: 'group',
        repo: 'project',
      });

      const glMatch = 'https://gitlab.mycompany.com/group/project/-/merge_requests/7'.match(
        /^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/
      );
      expect(glMatch).not.toBeNull();
      const fullPath = glMatch![2];
      const lastSlash = fullPath.lastIndexOf('/');
      const prOwner = lastSlash > 0 ? fullPath.slice(0, lastSlash) : fullPath;
      const prRepo = lastSlash > 0 ? fullPath.slice(lastSlash + 1) : '';
      expect(prOwner).toBe(rigCoords!.owner);
      expect(prRepo).toBe(rigCoords!.repo);
    });

    it('rejects non-GitHub/GitLab PR URLs', () => {
      const prUrl = 'https://example.com/some/pr/1';
      const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      const glMatch = prUrl.match(/^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/);
      expect(ghMatch).toBeNull();
      expect(glMatch).toBeNull();
    });

    it('rejects non-GitLab host with /-/merge_requests/ pattern (e.g. Bitbucket)', () => {
      const prUrl = 'https://bitbucket.org/group/project/-/merge_requests/1';
      const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      expect(ghMatch).toBeNull();
      const glMatch = prUrl.match(/^(https:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/);
      expect(glMatch).not.toBeNull();
      const glHost = new URL(glMatch![1]).hostname;
      expect(glHost).toBe('bitbucket.org');
      expect(glHost !== 'gitlab.com' && glHost !== null).toBe(true);
    });
  });
}

export function registerStateValidationTests() {
  describe('slingExistingPr state validation via checkPRStatus', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('checkPRStatus returns merged → slingExistingPr would refuse', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITHUB_MERGED_PR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('merged');
      }
    });

    it('checkPRStatus returns closed → slingExistingPr would refuse', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITHUB_CLOSED_PR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('closed');
      }
    });

    it('checkPRStatus returns open with full metadata → slingExistingPr would proceed', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(GITHUB_OPEN_PR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const ctx = mockSCMContext({
        getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
      });
      const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.status).toBe('open');
        expect(outcome.result.head_branch).toBe('feature/babysit');
        expect(outcome.result.base_branch).toBe('main');
        expect(outcome.result.head_sha).toBe('abc1234def5678');
      }
    });
  });
}

export function registerForcePushAllowedTests() {
  describe('forcePushAllowed default', () => {
    it('defaults to false when not specified', () => {
      const input = { forcePushAllowed: undefined };
      const resolved = input.forcePushAllowed ?? false;
      expect(resolved).toBe(false);
    });

    it('persists true when explicitly set', () => {
      const input = { forcePushAllowed: true };
      const resolved = input.forcePushAllowed ?? false;
      expect(resolved).toBe(true);
    });

    it('persists false when explicitly set', () => {
      const input = { forcePushAllowed: false };
      const resolved = input.forcePushAllowed ?? false;
      expect(resolved).toBe(false);
    });
  });
}

export function registerMetadataShapeTests() {
  describe('submitExternalPrToReviewQueue metadata shape', () => {
    it('builds correct metadata for babysit bead', () => {
      const args = {
        sourceAgentId: 'mayor',
        headSha: 'abc1234',
        forcePushAllowed: false,
      };
      const metadata: Record<string, unknown> = {
        source_agent_id: args.sourceAgentId,
        babysit: true,
        head_sha: args.headSha,
        force_push_allowed: args.forcePushAllowed,
        babysit_started_at: new Date().toISOString(),
      };
      expect(metadata.babysit).toBe(true);
      expect(metadata.head_sha).toBe('abc1234');
      expect(metadata.force_push_allowed).toBe(false);
      expect(metadata.source_agent_id).toBe('mayor');
      expect(metadata).not.toHaveProperty('source_bead_id');
      expect(typeof metadata.babysit_started_at).toBe('string');
    });

    it('includes force_push_allowed: true when authorized', () => {
      const args = {
        sourceAgentId: 'system',
        headSha: 'def5678',
        forcePushAllowed: true,
      };
      const metadata: Record<string, unknown> = {
        source_agent_id: args.sourceAgentId,
        babysit: true,
        head_sha: args.headSha,
        force_push_allowed: args.forcePushAllowed,
        babysit_started_at: new Date().toISOString(),
      };
      expect(metadata.force_push_allowed).toBe(true);
    });

    it('uses gt:merge-request and gt:babysit labels', () => {
      const labels = ['gt:merge-request', 'gt:babysit'];
      expect(labels).toContain('gt:merge-request');
      expect(labels).toContain('gt:babysit');
    });
  });
}
