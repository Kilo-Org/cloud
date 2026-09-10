/**
 * Unit tests for the MCP catalog dump library (src/scripts/mcp-catalog).
 *
 * The enumeration test imports the real rootRouter: it asserts the walk
 * yields leaves and that a known nested query path from the OpenAPI registry
 * (apps/web/src/lib/openapi/trpc-registry.ts) is present, so a refactor that
 * breaks router flattening fails here instead of shipping an empty catalog.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { rootRouter } from '@/routers/root-router';
import {
  CATALOG_JSON_DISPLAY_PATH,
  CATALOG_JSON_PATH,
  DENYLISTED_TOP_LEVEL_SEGMENTS,
  SUMMARY_INSTRUCTION,
  buildCatalogJson,
  buildCatalogRows,
  collectCatalogLeaves,
  generateMissingSummaries,
  readCommittedSummaries,
  type CatalogLeaf,
} from './catalog';

const queryLeaf = (path: string, firstInput?: CatalogLeaf['firstInput']): CatalogLeaf => ({
  path,
  type: 'query',
  firstInput,
});

describe('mcp-catalog catalog', () => {
  describe('collectCatalogLeaves', () => {
    it('yields leaves from the real rootRouter', () => {
      const leaves = collectCatalogLeaves(rootRouter);
      expect(leaves.length).toBeGreaterThan(0);
      for (const leaf of leaves) {
        expect(['query', 'mutation', 'subscription']).toContain(leaf.type);
      }
    });

    it('contains the known nested usageAnalytics query path', () => {
      const leaves = collectCatalogLeaves(rootRouter);
      const summary = leaves.find(leaf => leaf.path === 'usageAnalytics.getSummary');
      expect(summary).toBeDefined();
      expect(summary?.type).toBe('query');
    });
  });

  describe('buildCatalogRows', () => {
    it('keeps only queries and drops denylisted top-level segments', () => {
      const { rows, missing } = buildCatalogRows([
        queryLeaf('admin.users.list'),
        queryLeaf('debug.ping'),
        queryLeaf('test.echo'),
        { path: 'user.deleteAccount', type: 'mutation', firstInput: undefined },
        { path: 'user.onEvent', type: 'subscription', firstInput: undefined },
        queryLeaf('user.getProfile'),
      ]);
      expect(rows.map(row => row.path)).toEqual([]);
      expect(missing.map(leaf => leaf.path)).toEqual(['user.getProfile']);
    });

    it('locks the denylist constant to the internal-only segments', () => {
      expect([...DENYLISTED_TOP_LEVEL_SEGMENTS].sort()).toEqual(['admin', 'debug', 'test']);
    });

    it('fails on a zero-query catalog instead of emitting an empty one', () => {
      expect(() => buildCatalogRows([queryLeaf('admin.nothing')])).toThrow(/zero query rows/);
      expect(() => buildCatalogRows([])).toThrow(/zero query rows/);
    });

    it('shapes rows with derived tags, input schema and search blob', () => {
      const { rows } = buildCatalogRows(
        [queryLeaf('user.getProfile', z.object({ userId: z.string() }))],
        new Map([['user.getProfile', 'Returns the profile of a user.']])
      );
      const row = rows[0];
      expect(row).toEqual({
        path: 'user.getProfile',
        kind: 'query',
        summary: 'Returns the profile of a user.',
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: { userId: { type: 'string' } },
        }),
        tags: ['user', 'getprofile', 'userid'],
        searchBlob: 'user.getProfile Returns the profile of a user. user getprofile userid userId',
      });
      expect(row?.summary).toContain('profile');
    });

    it('emits an empty input schema for procedures without input', () => {
      const { rows } = buildCatalogRows(
        [queryLeaf('user.listSessions')],
        new Map([['user.listSessions', 'Lists active sessions.']])
      );
      expect(rows[0]?.inputSchema).toEqual({});
    });

    it('keeps committed summaries byte-for-byte, including whitespace', () => {
      const summary = '  Returns the user profile.  ';
      const { rows } = buildCatalogRows(
        [queryLeaf('user.getProfile')],
        new Map([['user.getProfile', summary]])
      );
      expect(rows[0]?.summary).toBe(summary);
    });
  });

  describe('CATALOG_JSON_DISPLAY_PATH', () => {
    it('is the repo-relative catalog path, stable across checkouts', () => {
      expect(CATALOG_JSON_DISPLAY_PATH).toBe('services/kilo-mcp/catalog.json');
      expect(CATALOG_JSON_PATH.endsWith(CATALOG_JSON_DISPLAY_PATH)).toBe(true);
    });
  });

  describe('buildCatalogJson', () => {
    it('sorts rows by path and ends with a trailing newline', () => {
      const { rows } = buildCatalogRows(
        [queryLeaf('b.b'), queryLeaf('a.a')],
        new Map([
          ['a.a', 'A'],
          ['b.b', 'B'],
        ])
      );
      const json = buildCatalogJson(rows);
      expect(json.endsWith('\n')).toBe(true);
      expect(json.indexOf('"a.a"')).toBeGreaterThan(-1);
      expect(json.indexOf('"a.a"')).toBeLessThan(json.indexOf('"b.b"'));
      expect(json).toBe(`${JSON.stringify({ 'a.a': rows[1], 'b.b': rows[0] }, null, 2)}\n`);
    });
  });

  describe('readCommittedSummaries', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mcp-catalog-test-'));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const writeCatalog = (name: string, content: string): string => {
      const path = join(tmpDir, name);
      writeFileSync(path, content);
      return path;
    };

    it('returns an empty Map when the committed catalog does not exist (first generation)', () => {
      const summaries = readCommittedSummaries(join(tmpDir, 'does-not-exist.json'));
      expect(summaries).toBeInstanceOf(Map);
      expect(summaries.size).toBe(0);
    });

    it('reads the summaries of a valid committed catalog, skipping empty ones', () => {
      const path = writeCatalog(
        'valid.json',
        JSON.stringify({
          'user.getProfile': { summary: 'Returns the profile of a user.' },
          'user.listSessions': { summary: '' },
          'kiloChat.ping': {},
        })
      );
      expect([...readCommittedSummaries(path).entries()]).toEqual([
        ['user.getProfile', 'Returns the profile of a user.'],
      ]);
    });

    it('throws naming the path when the committed catalog carries merge-conflict markers', () => {
      const path = writeCatalog(
        'conflict.json',
        '{\n  "user.getProfile": {\n    "summary": "edited by hand"\n  }\n<<<<<<< HEAD\n}\n=======\n}\n>>>>>>> feature/x\n'
      );
      expect(() => readCommittedSummaries(path)).toThrow(path);
      // The throw must explain the harm: an empty Map here would read as
      // "first generation" and silently regenerate every author edit.
      expect(() => readCommittedSummaries(path)).toThrow(/not valid JSON/);
    });

    it('throws naming the path when the committed catalog is truncated JSON', () => {
      const path = writeCatalog('truncated.json', '{"user.getProfile": {"summary": "Retu');
      expect(() => readCommittedSummaries(path)).toThrow(path);
    });

    it('throws naming the path when the committed catalog parses to a non-object', () => {
      const path = writeCatalog('not-an-object.json', 'null\n');
      expect(() => readCommittedSummaries(path)).toThrow(path);
    });

    it('throws naming the path when the committed catalog exists but cannot be read', () => {
      const dirPath = join(tmpDir, 'directory.json');
      mkdirSync(dirPath);
      expect(() => readCommittedSummaries(dirPath)).toThrow(dirPath);
    });
  });

  describe('committed catalog regeneration', () => {
    it('regenerates the committed catalog byte-for-byte with no missing summaries', () => {
      const onDisk = readFileSync(CATALOG_JSON_PATH, 'utf8');
      const committed = readCommittedSummaries();
      expect(committed.size).toBeGreaterThan(0);
      const { rows, missing } = buildCatalogRows(collectCatalogLeaves(rootRouter), committed);
      expect(missing.map(leaf => leaf.path)).toEqual([]);
      expect(buildCatalogJson(rows)).toBe(onDisk);
    });
  });

  describe('generateMissingSummaries', () => {
    const ENV_KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] as const;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const failingFetch = jest.fn(async () => {
      throw new Error('network must not be reached');
    }) as unknown as typeof fetch;

    it('resolves immediately when nothing is missing', async () => {
      await expect(generateMissingSummaries([], failingFetch)).resolves.toEqual(new Map());
      expect(failingFetch).not.toHaveBeenCalled();
    });

    it('fails without retry when no LLM key is configured', async () => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const attempt = generateMissingSummaries([queryLeaf('usageAnalytics.probe')], failingFetch);
      await expect(attempt).rejects.toThrow(/OPENROUTER_API_KEY|ANTHROPIC_API_KEY/);
      // Fork PRs never get the CI key, so the error must also name the
      // credential-free self-service path (requirement 6's guidance).
      await expect(attempt).rejects.toThrow(
        /hand-write a summary for each new path in services\/kilo-mcp\/catalog\.json/
      );
      expect(failingFetch).not.toHaveBeenCalled();
    });

    it('marks provider outages as retryable and names the failed batch', async () => {
      process.env.OPENROUTER_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_API_KEY;
      const fetchImpl = jest.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => 'upstream unavailable',
        json: async () => ({}),
      })) as unknown as typeof fetch;

      await expect(
        generateMissingSummaries([queryLeaf('usageAnalytics.probe')], fetchImpl)
      ).rejects.toMatchObject({
        retryable: true,
        message: expect.stringMatching(/usage-analytics-router\.ts/),
      });
    });

    it('marks provider auth rejections as non-retryable', async () => {
      process.env.OPENROUTER_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_API_KEY;
      const fetchImpl = jest.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'invalid key',
        json: async () => ({}),
      })) as unknown as typeof fetch;

      await expect(
        generateMissingSummaries([queryLeaf('usageAnalytics.probe')], fetchImpl)
      ).rejects.toMatchObject({
        retryable: false,
      });
    });

    it('batches one request per router file and parses the summaries', async () => {
      process.env.OPENROUTER_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_API_KEY;
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = jest.fn(async (url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        calls.push({ url: String(url), body });
        const content =
          (body as { messages?: Array<{ content?: string }> }).messages?.[0]?.content ?? '';
        // Echo one summary per procedure the batch requested.
        const out: Record<string, string> = {};
        for (const match of content.matchAll(/^- ([A-Za-z0-9_.]+)$/gm))
          out[match[1]!] = `Summary for ${match[1]}.`;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }),
        };
      }) as unknown as typeof fetch;

      const summaries = await generateMissingSummaries(
        [queryLeaf('usageAnalytics.probe'), queryLeaf('kiloChat.probe')],
        fetchImpl
      );
      expect(summaries.get('usageAnalytics.probe')).toBe('Summary for usageAnalytics.probe.');
      expect(summaries.get('kiloChat.probe')).toBe('Summary for kiloChat.probe.');
      expect(calls).toHaveLength(2); // one per router file, batched
      const prompt = JSON.stringify(calls[0]?.body);
      expect(prompt).toContain(SUMMARY_INSTRUCTION);
      expect(prompt).toContain('usageAnalytics.probe');
    });

    it('logs a progress line naming each router-file batch as it starts', async () => {
      process.env.OPENROUTER_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_API_KEY;
      const events: string[] = [];
      const fetchImpl = jest.fn(async (_url: unknown, init?: { body?: string }) => {
        events.push('fetch');
        const body = JSON.parse(init?.body ?? '{}') as {
          messages?: Array<{ content?: string }>;
        };
        const out: Record<string, string> = {};
        for (const match of (body.messages?.[0]?.content ?? '').matchAll(/^- ([A-Za-z0-9_.]+)$/gm))
          out[match[1]!] = `Summary for ${match[1]}.`;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }),
        };
      }) as unknown as typeof fetch;

      await generateMissingSummaries(
        [queryLeaf('usageAnalytics.probe'), queryLeaf('kiloChat.probe')],
        fetchImpl,
        message => events.push(message)
      );
      // Each batch is named (router file + count) before its request starts.
      expect(events).toEqual([
        expect.stringContaining('usage-analytics-router.ts'),
        'fetch',
        expect.stringContaining('kilo-chat-router.ts'),
        'fetch',
      ]);
      expect(events[0]).toContain('1/2');
      expect(events[0]).toContain('1 summary');
      expect(events[2]).toContain('2/2');
    });

    it('rejects unusable LLM output as non-retryable', async () => {
      process.env.OPENROUTER_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_API_KEY;
      const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"some.other.path": "wrong key"}' } }],
        }),
      })) as unknown as typeof fetch;

      await expect(
        generateMissingSummaries([queryLeaf('usageAnalytics.probe')], fetchImpl)
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining('usageAnalytics.probe'),
      });
    });

    it('extracts the enclosing handler source for a real procedure', async () => {
      process.env.OPENROUTER_API_KEY = 'test-key';
      delete process.env.ANTHROPIC_API_KEY;
      const bodies: string[] = [];
      const fetchImpl = jest.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(init?.body ?? '');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    'usageAnalytics.getSummary': 'Returns aggregate usage KPI metrics.',
                  }),
                },
              },
            ],
          }),
        };
      }) as unknown as typeof fetch;

      await generateMissingSummaries([queryLeaf('usageAnalytics.getSummary')], fetchImpl);
      const parsed = JSON.parse(bodies[0] ?? '{}') as { messages: Array<{ content: string }> };
      const content = parsed.messages[0]?.content ?? '';
      // The extracted block should include the real handler, not just the path.
      expect(content).toMatch(/getSummary/);
      expect(content.length).toBeGreaterThan(200);
    });
  });
});
