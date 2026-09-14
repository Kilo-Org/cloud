import { describe, expect, it, vi } from 'vitest';
import { noSemanticCandidates, searchCatalog, tokenize } from './search';
import type { Catalog } from './types';

/**
 * Test catalog mirroring the shape of services/kilo-mcp/catalog.json. It is
 * inline (not a committed fixture) so unit tests never depend on catalog
 * regeneration drift.
 */
export const testCatalog: Catalog = {
  'organizations.list': {
    path: 'organizations.list',
    kind: 'query',
    summary: 'List the organizations the user belongs to.',
    inputSchema: {},
    tags: ['organizations', 'list'],
    searchBlob: 'organizations.list List the organizations the user belongs to. organizations list',
  },
  'cliSessions.search': {
    path: 'cliSessions.search',
    kind: 'query',
    summary: 'Search the user CLI sessions by keyword.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    tags: ['clisessions', 'search'],
    searchBlob:
      'cliSessions.search Search the user CLI sessions by keyword. clisessions search query',
  },
  'user.getBalance': {
    path: 'user.getBalance',
    kind: 'query',
    summary: 'Get the user credit balance.',
    inputSchema: {},
    tags: ['user', 'balance'],
    searchBlob: 'user.getBalance Get the user credit balance. user getbalance balance credit',
  },
  'usageAnalytics.getSummary': {
    path: 'usageAnalytics.getSummary',
    kind: 'query',
    summary: 'Get usage summary analytics for a scope.',
    inputSchema: {},
    tags: ['usageanalytics', 'summary'],
    searchBlob:
      'usageAnalytics.getSummary Get usage summary analytics for a scope. usageanalytics getsummary usage summary',
  },
  'organizations.members.listPublic': {
    path: 'organizations.members.listPublic',
    kind: 'query',
    summary: 'List public members of an organization.',
    inputSchema: {},
    tags: ['organizations', 'members'],
    searchBlob:
      'organizations.members.listPublic List public members of an organization. organizations members listpublic list public',
  },
};

describe('tokenize', () => {
  it('splits camelCase, dots, and prose into lowercase tokens', () => {
    expect(tokenize('activeSessions.getToken')).toEqual(['active', 'sessions', 'get', 'token']);
    expect(tokenize('List the user!')).toEqual(['list', 'the', 'user']);
    expect(tokenize('  ')).toEqual([]);
  });
});

describe('searchCatalog', () => {
  it('ranks an exact full path above a path-sequence match and single-token overlaps', async () => {
    const results = await searchCatalog('organizations.list', { catalog: testCatalog });
    expect(results[0]?.path).toBe('organizations.list');
    // exact path match beats plain token overlap; a row with no query token
    // in its blob drops out entirely
    const scores = Object.fromEntries(results.map(row => [row.path, row.score]));
    expect(scores['organizations.list']).toBeGreaterThan(
      scores['organizations.members.listPublic']
    );
    expect('user.getBalance' in scores).toBe(false);
  });

  it('weights a contiguous query sequence in the path above scattered single-token hits', async () => {
    // "list public" is a contiguous sequence in organizations.members.listPublic
    // and only scattered tokens elsewhere.
    const results = await searchCatalog('list public', { catalog: testCatalog });
    expect(results[0]?.path).toBe('organizations.members.listPublic');
  });

  it('is deterministic: equal scores tie-break by path ascending', async () => {
    // both rows hit only the token "list" at the same overlap score
    const a = await searchCatalog('list', { catalog: testCatalog });
    const b = await searchCatalog('list', { catalog: testCatalog });
    expect(a.map(row => row.path)).toEqual(b.map(row => row.path));
    expect(a.length).toBeGreaterThan(1);
    expect(a.every(row => row.score === a[0]?.score)).toBe(true);
    expect(a[0]?.path).toBe('organizations.list');
    expect(a[1]?.path).toBe('organizations.members.listPublic');
  });

  it('honors limit and returns the shape {path, kind, summary, tags, score}', async () => {
    const results = await searchCatalog('list', { catalog: testCatalog, limit: 1 });
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual(['kind', 'path', 'score', 'summary', 'tags']);
    expect(results[0]).toMatchObject({ kind: 'query' });
  });

  it('returns zero rows for a query that matches nothing (empty state, not an error)', async () => {
    expect(await searchCatalog('zzqqx nonexistent', { catalog: testCatalog })).toEqual([]);
  });

  it('returns zero rows for a blank query', async () => {
    expect(await searchCatalog('   ', { catalog: testCatalog })).toEqual([]);
  });

  it('defaults the semantic hook to no candidates', async () => {
    expect(await noSemanticCandidates('anything', 10)).toEqual([]);
  });

  it('blends injected semantic candidates into the ranking (s3 hook)', async () => {
    const semantic = vi.fn(async () => [{ path: 'user.getBalance', score: 1 }]);
    const results = await searchCatalog('balance', {
      catalog: testCatalog,
      semanticCandidates: semantic,
    });
    expect(semantic).toHaveBeenCalledWith('balance', 10);
    expect(results[0]?.path).toBe('user.getBalance');
    // lexical 10 (full overlap) + semantic 1*5
    expect(results[0]?.score).toBeCloseTo(15);
  });

  it('admits a semantic-only row and ignores candidates outside the catalog', async () => {
    const results = await searchCatalog('zzqqx', {
      catalog: testCatalog,
      semanticCandidates: async () => [
        { path: 'usageAnalytics.getSummary', score: 0.9 },
        { path: 'not.in.catalog', score: 1 },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe('usageAnalytics.getSummary');
  });

  it('ranks every token/exact hit above a semantic-only hit (requirement 1)', async () => {
    // A nine-token query: three rows match exactly one token ("user"), scoring
    // the minimum lexical score. A full-similarity semantic-only candidate
    // (no lexical overlap at all) must stay below that weakest lexical hit.
    const longQuery = 'refund invoice export csv quarterly revenue breakdown user report';
    const results = await searchCatalog(longQuery, {
      catalog: testCatalog,
      semanticCandidates: async () => [{ path: 'usageAnalytics.getSummary', score: 1 }],
    });
    expect(results[results.length - 1]?.path).toBe('usageAnalytics.getSummary');
    const semanticOnly = results.find(row => row.path === 'usageAnalytics.getSummary');
    const lexicalScores = results
      .filter(row => row.path !== 'usageAnalytics.getSummary')
      .map(row => row.score);
    expect(lexicalScores.length).toBe(3);
    expect(semanticOnly?.score).toBeLessThan(Math.min(...lexicalScores));
  });

  it('degrades to token-only results with a logged note when semantic search fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = await searchCatalog('balance', {
        catalog: testCatalog,
        semanticCandidates: async () => {
          throw new Error('Vectorize unavailable');
        },
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.map(row => row.path)).toContain('user.getBalance');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('semantic search degraded to token-only results')
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vectorize unavailable'));
    } finally {
      warn.mockRestore();
    }
  });
});
