import { describe, it, expect, vi } from 'vitest';
import { checkPRStatus, type SCMContext } from '../../src/dos/town/town-scm';
import { parsePrUrlForRepoMatch, parseGitUrl } from '../../src/util/platform-pr.util';
import { submitExternalPrToReviewQueue } from '../../src/dos/town/review-queue';
import type { TownConfig } from '../../src/types';

class MiniSql {
  private inserts: { table: string; params: unknown[] }[] = [];
  private selectResults: Map<string, Record<string, unknown>[]> = new Map();

  exec(stmt: string, ...params: unknown[]): SqlStoragecursor {
    this.captureInsert(stmt, params);
    const selectRows = this.matchSelect(stmt, params);
    if (selectRows !== undefined) {
      return this.cursorFromRows(selectRows);
    }
    return this.cursorFromRows([]);
  }

  private captureInsert(stmt: string, params: unknown[]): void {
    const match = stmt.match(/INSERT\s+INTO\s+(\S+)/i);
    if (match) {
      this.inserts.push({ table: match[1], params });
    }
  }

  private matchSelect(stmt: string, _params: unknown[]): Record<string, unknown>[] | undefined {
    for (const [key, rows] of this.selectResults) {
      if (stmt.includes(key)) {
        return rows;
      }
    }
    return undefined;
  }

  private cursorFromRows(rows: Record<string, unknown>[]): SqlStoragecursor {
    return {
      get rows(): unknown[][] {
        return rows as unknown as unknown[][];
      },
      get columns(): string[] {
        return rows.length > 0 ? Object.keys(rows[0]) : [];
      },
      cursor: {
        next(): string | null {
          return null;
        },
        get value(): unknown[] {
          return [];
        },
      },
      [Symbol.iterator]() {
        return (rows as unknown as unknown[][])[Symbol.iterator]();
      },
    } as unknown as SqlStoragecursor;
  }

  addSelectResult(key: string, rows: Record<string, unknown>[]): void {
    this.selectResults.set(key, rows);
  }

  getInserts(): { table: string; params: unknown[] }[] {
    return this.inserts;
  }

  findBeadInsert(): { table: string; params: unknown[] } | undefined {
    return this.inserts.find(i => /beads$/i.test(i.table));
  }

  findReviewMetadataInsert(): { table: string; params: unknown[] } | undefined {
    return this.inserts.find(i => /review_metadata$/i.test(i.table));
  }

  findEventInsert(): { table: string; params: unknown[] } | undefined {
    return this.inserts.find(i => /bead_events$/i.test(i.table));
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

  it('parses GitLab MR URL for root-level project (no group)', () => {
    const result = parsePrUrlForRepoMatch('https://gitlab.com/myproject/-/merge_requests/1');
    expect(result).toEqual({ platform: 'gitlab', owner: '', repo: 'myproject' });
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

describe('submitExternalPrToReviewQueue force_push_allowed', () => {
  it('defaults force_push_allowed to false when slingExistingPr omits it', () => {
    const sql = new MiniSql() as unknown as SqlStorage;
    const { beadId } = submitExternalPrToReviewQueue(sql, {
      rigId: 'rig-1',
      prUrl: 'https://github.com/Org/repo/pull/1',
      branch: 'feature/x',
      targetBranch: 'main',
      headSha: 'abc1234',
      title: 'Babysit: Test PR',
      forcePushAllowed: false,
      sourceAgentId: 'mayor',
    });

    expect(beadId).toBeTruthy();

    const beadInsert = sql.findBeadInsert();
    expect(beadInsert).toBeTruthy();
    const metadata = JSON.parse(beadInsert!.params[10] as string);
    expect(metadata.force_push_allowed).toBe(false);
    expect(metadata.babysit).toBe(true);
    expect(metadata.head_sha).toBe('abc1234');
  });

  it('persists force_push_allowed: true when explicitly set', () => {
    const sql = new MiniSql() as unknown as SqlStorage;
    submitExternalPrToReviewQueue(sql, {
      rigId: 'rig-1',
      prUrl: 'https://github.com/Org/repo/pull/1',
      branch: 'feature/x',
      targetBranch: 'main',
      headSha: 'def5678',
      title: 'Babysit: Another PR',
      forcePushAllowed: true,
      sourceAgentId: 'system',
    });

    const beadInsert = sql.findBeadInsert();
    expect(beadInsert).toBeTruthy();
    const metadata = JSON.parse(beadInsert!.params[10] as string);
    expect(metadata.force_push_allowed).toBe(true);
  });

  it('creates review_metadata row and babysit_started event', () => {
    const sql = new MiniSql() as unknown as SqlStorage;
    submitExternalPrToReviewQueue(sql, {
      rigId: 'rig-1',
      prUrl: 'https://github.com/Org/repo/pull/1',
      branch: 'feature/x',
      targetBranch: 'main',
      headSha: 'abc1234',
      title: 'Babysit: Test',
      forcePushAllowed: false,
      sourceAgentId: 'mayor',
    });

    const rmInsert = sql.findReviewMetadataInsert();
    expect(rmInsert).toBeTruthy();
    expect(rmInsert!.params[1]).toBe('feature/x');
    expect(rmInsert!.params[2]).toBe('main');
    expect(rmInsert!.params[4]).toBe('https://github.com/Org/repo/pull/1');

    const eventInsert = sql.findEventInsert();
    expect(eventInsert).toBeTruthy();
    expect(eventInsert!.params[3]).toBe('babysit_started');
  });

  it('includes gt:babysit label alongside gt:merge-request', () => {
    const sql = new MiniSql() as unknown as SqlStorage;
    submitExternalPrToReviewQueue(sql, {
      rigId: 'rig-1',
      prUrl: 'https://github.com/Org/repo/pull/1',
      branch: 'feature/x',
      targetBranch: 'main',
      headSha: 'abc1234',
      title: 'Babysit: Test',
      forcePushAllowed: false,
      sourceAgentId: 'mayor',
    });

    const beadInsert = sql.findBeadInsert();
    expect(beadInsert).toBeTruthy();
    const labels = JSON.parse(beadInsert!.params[9] as string);
    expect(labels).toContain('gt:merge-request');
    expect(labels).toContain('gt:babysit');
  });

  it('returns existing beadId with warning when duplicate prUrl exists', () => {
    const sql = new MiniSql() as unknown as SqlStorage;
    (sql as MiniSql).addSelectResult('pr_url', [{ bead_id: 'existing-bead-id' }]);

    const result = submitExternalPrToReviewQueue(sql, {
      rigId: 'rig-1',
      prUrl: 'https://github.com/Org/repo/pull/1',
      branch: 'feature/x',
      targetBranch: 'main',
      headSha: 'abc1234',
      title: 'Babysit: Test',
      forcePushAllowed: false,
      sourceAgentId: 'mayor',
    });

    expect(result.beadId).toBe('existing-bead-id');
    expect(result.warning).toContain('already exists');
    expect(sql.findBeadInsert()).toBeUndefined();
  });
});
