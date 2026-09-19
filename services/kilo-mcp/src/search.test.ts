import { describe, expect, it, vi } from 'vitest';
import { searchCatalog, searchCatalogDetailed, noSemanticCandidates, tokenize } from './search';
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
  'admin.getMetrics': {
    path: 'admin.getMetrics',
    kind: 'query',
    summary: 'Get admin-only platform metrics.',
    inputSchema: {},
    tags: ['admin'],
    searchBlob: 'admin.getMetrics Get admin-only platform metrics. admin getmetrics metrics',
    admin: true,
  },
  'debug.getState': {
    path: 'debug.getState',
    kind: 'query',
    summary: 'Read the debug platform state.',
    inputSchema: {},
    tags: ['debug'],
    searchBlob: 'debug.getState Read the debug platform state. debug getstate state',
    debug: true,
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

  it('honors limit and returns the shape {path, kind, summary, tags, score, inputSchema}', async () => {
    const results = await searchCatalog('list', { catalog: testCatalog, limit: 1 });
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual([
      'inputSchema',
      'kind',
      'path',
      'score',
      'summary',
      'tags',
    ]);
    expect(results[0]).toMatchObject({ kind: 'query' });
  });

  it('returns each row its catalog input schema byte-for-byte', async () => {
    const results = await searchCatalog('cliSessions search', { catalog: testCatalog });
    const hit = results.find(row => row.path === 'cliSessions.search');
    expect(hit).toBeDefined();
    // toEqual locks byte-identity with the published catalog row (the schema
    // `call` validates against), not just a structural subset.
    expect(hit?.inputSchema).toEqual(testCatalog['cliSessions.search']!.inputSchema);
    // The documented promise: the agent can read the required field list.
    expect(hit?.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
    });
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
    // The semantic-only branch carries the published schema like a lexical hit.
    expect(results[0]?.inputSchema).toEqual(testCatalog['usageAnalytics.getSummary']!.inputSchema);
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

  it('hides admin and debug rows unless the caller opted in with includeGuarded: true', async () => {
    // `metrics` matches only the admin row, so the hidden case is empty.
    for (const includeGuarded of [undefined, false]) {
      const results = await searchCatalog('metrics', {
        catalog: testCatalog,
        ...(includeGuarded === undefined ? {} : { includeGuarded }),
      });
      expect(results).toEqual([]);
    }
    const optedIn = await searchCatalog('metrics', {
      catalog: testCatalog,
      includeGuarded: true,
    });
    expect(optedIn.map(row => row.path)).toEqual(['admin.getMetrics']);
  });

  it('treats a debug: true row exactly like an admin: true row for the gate', async () => {
    for (const includeGuarded of [undefined, false]) {
      const results = await searchCatalog('debug', {
        catalog: testCatalog,
        ...(includeGuarded === undefined ? {} : { includeGuarded }),
      });
      expect(results.map(row => row.path)).not.toContain('debug.getState');
    }
    const optedIn = await searchCatalog('debug', {
      catalog: testCatalog,
      includeGuarded: true,
    });
    expect(optedIn.map(row => row.path)).toEqual(['debug.getState']);
  });

  it('marks a returned guarded hit requiresApproval, for admin and debug alike', async () => {
    const results = await searchCatalog('metrics', {
      catalog: testCatalog,
      includeGuarded: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path: 'admin.getMetrics', requiresApproval: true });

    const debug = await searchCatalog('debug', {
      catalog: testCatalog,
      includeGuarded: true,
    });
    expect(debug[0]).toMatchObject({ path: 'debug.getState', requiresApproval: true });
  });

  it('leaves a non-guarded hit unmarked (no requiresApproval key)', async () => {
    const results = await searchCatalog('balance', { catalog: testCatalog });
    expect(results[0]?.path).toBe('user.getBalance');
    expect('requiresApproval' in (results[0] as object)).toBe(false);
  });

  it('marks a guarded hit admitted only by the semantic hook', async () => {
    const results = await searchCatalog('zzqqx nothing', {
      catalog: testCatalog,
      semanticCandidates: async () => [{ path: 'debug.getState', score: 1 }],
      includeGuarded: true,
    });
    expect(results[0]).toMatchObject({ path: 'debug.getState', requiresApproval: true });
  });

  it('does not let a semantic candidate smuggle an admin or debug row past the gate', async () => {
    // The query matches no row lexically, so the guarded rows can only arrive
    // through the semantic hook — which must apply the same fail-closed gate.
    for (const path of ['admin.getMetrics', 'debug.getState']) {
      const semanticCandidates = async () => [{ path, score: 1 }];
      expect(
        await searchCatalog('zzqqx nothing', { catalog: testCatalog, semanticCandidates })
      ).toEqual([]);
      const optedIn = await searchCatalog('zzqqx nothing', {
        catalog: testCatalog,
        semanticCandidates,
        includeGuarded: true,
      });
      expect(optedIn.map(row => row.path)).toEqual([path]);
    }
  });

  it('reports a withheld guarded match from the single pass, reusing the semantic candidates', async () => {
    const semantic = vi.fn(async () => []);
    const { results, hiddenGuardedMatches } = await searchCatalogDetailed('metrics', {
      catalog: testCatalog,
      semanticCandidates: semantic,
    });
    expect(results).toEqual([]);
    expect(hiddenGuardedMatches).toBe(true);
    // The signal costs no second embedding/Vectorize query.
    expect(semantic).toHaveBeenCalledTimes(1);
  });

  it('reports a withheld semantic-only guarded candidate without a second query', async () => {
    const semantic = vi.fn(async () => [{ path: 'admin.getMetrics', score: 1 }]);
    const { results, hiddenGuardedMatches } = await searchCatalogDetailed('zzqqx nothing', {
      catalog: testCatalog,
      semanticCandidates: semantic,
    });
    expect(results).toEqual([]);
    expect(hiddenGuardedMatches).toBe(true);
    expect(semantic).toHaveBeenCalledTimes(1);
  });

  it('reports a withheld debug match, not only an admin one', async () => {
    const { results, hiddenGuardedMatches } = await searchCatalogDetailed('debug', {
      catalog: testCatalog,
    });
    expect(results).toEqual([]);
    expect(hiddenGuardedMatches).toBe(true);
  });

  it('reports no withheld guarded match for a query that matches nothing', async () => {
    const { results, hiddenGuardedMatches } = await searchCatalogDetailed('zzqqx nothing', {
      catalog: testCatalog,
    });
    expect(results).toEqual([]);
    expect(hiddenGuardedMatches).toBe(false);
  });

  it('never reports a withheld guarded match for an opted-in grant', async () => {
    const { hiddenGuardedMatches } = await searchCatalogDetailed('metrics', {
      catalog: testCatalog,
      includeGuarded: true,
    });
    expect(hiddenGuardedMatches).toBe(false);
  });

  it('still returns the ordinary rows and result shape through searchCatalogDetailed', async () => {
    const { results, hiddenGuardedMatches } = await searchCatalogDetailed('balance', {
      catalog: testCatalog,
    });
    expect(results[0]?.path).toBe('user.getBalance');
    expect(hiddenGuardedMatches).toBe(false);
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
      // The degraded (token-only) rows still carry their published schemas.
      const hit = results.find(row => row.path === 'user.getBalance');
      expect(hit?.inputSchema).toEqual(testCatalog['user.getBalance']!.inputSchema);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('semantic search degraded to token-only results')
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vectorize unavailable'));
    } finally {
      warn.mockRestore();
    }
  });
});
