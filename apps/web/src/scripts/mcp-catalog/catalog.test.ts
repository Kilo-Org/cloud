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
  SUMMARY_INSTRUCTION,
  buildCatalogJson,
  buildCatalogRows,
  collectCatalogLeaves,
  generateMissingSummaries,
  isDenylistedPath,
  parseKiloCompletion,
  procedureRequiresAdmin,
  readCommittedSummaries,
  runKiloCompletion,
  type CatalogLeaf,
} from './catalog';

const queryLeaf = (path: string, inputs: CatalogLeaf['inputs'] = []): CatalogLeaf => ({
  path,
  type: 'query',
  inputs,
});

const mutationLeaf = (path: string, inputs: CatalogLeaf['inputs'] = []): CatalogLeaf => ({
  path,
  type: 'mutation',
  inputs,
});

/**
 * A fixture leaf set that satisfies the mutation drift guard: the fixture's own
 * leaves plus one non-denylisted mutation. The extra leaf carries no summary,
 * so it lands in `missing` and never disturbs a `rows` assertion.
 */
const withMutation = (leaves: CatalogLeaf[]): CatalogLeaf[] => [
  ...leaves,
  mutationLeaf('user.updateProfile'),
];

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
    it('keeps every non-denylisted query and mutation, dropping internal paths and subscriptions', () => {
      const { rows, missing } = buildCatalogRows(
        [
          queryLeaf('admin.users.list'),
          queryLeaf('debug.ping'),
          queryLeaf('test.echo'),
          queryLeaf('organizations.admin.list'),
          mutationLeaf('admin.users.delete'),
          mutationLeaf('organizations.admin.grantCredit'),
          mutationLeaf('codingPlans.adminMarkRevocationFailed'),
          mutationLeaf('slack.devRemoveDbRowOnly'),
          mutationLeaf('organizations.subscription.cancel'),
          mutationLeaf('user.deleteAccount'),
          { path: 'user.onEvent', type: 'subscription', inputs: [] },
          queryLeaf('user.getProfile'),
          mutationLeaf('user.updateProfile'),
          queryLeaf('slack.testConnection'),
        ],
        new Map([
          ['user.getProfile', 'Returns the profile of a user.'],
          ['organizations.subscription.cancel', 'Cancel the subscription.'],
          ['user.deleteAccount', 'Delete the account.'],
          ['user.updateProfile', 'Update the profile.'],
          ['slack.testConnection', 'Test a Slack connection.'],
          ['admin.users.delete', 'Delete a user (internal).'],
          ['organizations.admin.grantCredit', 'Grant credit (internal).'],
          ['codingPlans.adminMarkRevocationFailed', 'Mark revocation failed (internal).'],
          ['slack.devRemoveDbRowOnly', 'Remove a DB row (dev only).'],
        ])
      );
      // Every non-internal query and mutation with a summary is a row; a
      // denylisted segment anywhere in the path and subscriptions are dropped,
      // summary or not. `testConnection` stays because `test` is exact-only,
      // and the summary-less `debug.ping` is published and waits for the LLM
      // pass because `debug` stays published and guarded.
      expect(rows.map(row => row.path)).toEqual([
        'organizations.subscription.cancel',
        'user.deleteAccount',
        'user.getProfile',
        'user.updateProfile',
        'slack.testConnection',
      ]);
      expect(rows.map(row => row.kind)).toEqual([
        'mutation',
        'mutation',
        'query',
        'mutation',
        'query',
      ]);
      expect(missing.map(leaf => leaf.path)).toEqual(['debug.ping']);
    });

    it('treats an internal segment anywhere in the path as internal', () => {
      expect(isDenylistedPath('admin.users.list')).toBe(true);
      expect(isDenylistedPath('organizations.admin.grantCredit')).toBe(true);
      expect(isDenylistedPath('codingPlans.adminInsights')).toBe(true);
      expect(isDenylistedPath('test.echo')).toBe(true);
      expect(isDenylistedPath('slack.devRemoveDbRowOnly')).toBe(true);
      expect(isDenylistedPath('user.getProfile')).toBe(false);
      expect(isDenylistedPath('slack.testConnection')).toBe(false);
      // `debug` is published and carries the guard marker, so it is not internal.
      expect(isDenylistedPath('debug.ping')).toBe(false);
    });

    it('fails on a zero-row catalog instead of emitting an empty one', () => {
      expect(() => buildCatalogRows([queryLeaf('admin.nothing')])).toThrow(/zero catalog rows/);
      expect(() => buildCatalogRows([])).toThrow(/zero catalog rows/);
    });

    it('throws when the enumeration exposes no mutation', () => {
      // A query-only enumeration (a wholesale router drift) must not publish a
      // mutation-free catalog in silence: write support would vanish.
      expect(() => buildCatalogRows([queryLeaf('user.getProfile')])).toThrow(
        /zero mutation procedures/
      );
    });

    it('shapes rows with derived tags, input schema and search blob', () => {
      const { rows } = buildCatalogRows(
        withMutation([queryLeaf('user.getProfile', [z.object({ userId: z.string() })])]),
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
        withMutation([queryLeaf('user.listSessions')]),
        new Map([['user.listSessions', 'Lists active sessions.']])
      );
      expect(rows[0]?.inputSchema).toEqual({});
    });

    it('composes every chained .input() schema into one object schema', () => {
      const { rows } = buildCatalogRows(
        withMutation([
          mutationLeaf('workspaceFolders.create', [
            z.object({ organizationId: z.uuid().nullable() }),
            z.object({ name: z.string(), color: z.string() }),
          ]),
        ]),
        new Map([['workspaceFolders.create', 'Creates a workspace folder.']])
      );
      const schema = rows[0]?.inputSchema;
      expect(schema).toMatchObject({
        type: 'object',
        properties: {
          organizationId: expect.any(Object),
          name: { type: 'string' },
          color: { type: 'string' },
        },
      });
      expect(schema?.['required']).toEqual(
        expect.arrayContaining(['organizationId', 'name', 'color'])
      );
    });

    it('keeps every constraint when two chained schemas declare the same key', () => {
      const { rows } = buildCatalogRows(
        withMutation([
          mutationLeaf('user.rename', [z.object({ id: z.string() }), z.object({ id: z.uuid() })]),
        ]),
        new Map([['user.rename', 'Renames a user.']])
      );
      const properties = rows[0]?.inputSchema['properties'] as Record<string, unknown>;
      expect(properties['id']).toEqual({ allOf: [{ type: 'string' }, expect.any(Object)] });
    });

    it('falls back to a top-level allOf when a chained schema carries extra keywords', () => {
      // A `.strict()` input rejects keys another input contributes, so the
      // flattened union would advertise a more permissive schema than tRPC
      // enforces. The intersection keeps `additionalProperties: false`.
      const { rows } = buildCatalogRows(
        withMutation([
          mutationLeaf('repo.list', [
            z.object({ organizationId: z.string() }),
            z.object({ organizationId: z.string(), platform: z.string() }).strict(),
          ]),
        ]),
        new Map([['repo.list', 'Lists repositories.']])
      );
      const schema = rows[0]?.inputSchema;
      const allOf = schema?.['allOf'] as Record<string, unknown>[] | undefined;
      expect(Array.isArray(allOf)).toBe(true);
      expect(allOf?.some(sub => sub['additionalProperties'] === false)).toBe(true);
      expect(rows[0]?.tags).toEqual(expect.arrayContaining(['organizationid', 'platform']));
    });

    it('keeps the tags of every chained input schema field', () => {
      const { rows } = buildCatalogRows(
        withMutation([
          mutationLeaf('workspaceFolders.create', [
            z.object({ organizationId: z.uuid().nullable() }),
            z.object({ name: z.string(), color: z.string() }),
          ]),
        ]),
        new Map([['workspaceFolders.create', 'Creates a workspace folder.']])
      );
      expect(rows[0]?.tags).toEqual(expect.arrayContaining(['organizationid', 'name', 'color']));
    });

    it('keeps committed summaries byte-for-byte, including whitespace', () => {
      const summary = '  Returns the user profile.  ';
      const { rows } = buildCatalogRows(
        withMutation([queryLeaf('user.getProfile')]),
        new Map([['user.getProfile', summary]])
      );
      expect(rows[0]?.summary).toBe(summary);
    });

    it('marks a real admin-guarded procedure with the trailing admin marker', () => {
      const { rows } = buildCatalogRows(
        withMutation([queryLeaf('organizations.seatPurchases')]),
        new Map([['organizations.seatPurchases', 'Lists seat purchases.']])
      );
      const row = rows[0];
      expect(row?.admin).toBe(true);
      // Key order stays deterministic for the dump's byte-for-byte check.
      expect(Object.keys(row ?? {})).toEqual([
        'path',
        'kind',
        'summary',
        'inputSchema',
        'tags',
        'searchBlob',
        'admin',
      ]);
    });

    it('leaves the admin key off a real non-admin procedure', () => {
      const { rows } = buildCatalogRows(
        withMutation([queryLeaf('user.getBalance')]),
        new Map([['user.getBalance', 'Returns the credit balance.']])
      );
      expect(rows[0]).not.toHaveProperty('admin');
      expect(Object.keys(rows[0] ?? {})).toEqual([
        'path',
        'kind',
        'summary',
        'inputSchema',
        'tags',
        'searchBlob',
      ]);
    });

    it('keeps a debug leaf and marks it debug without an admin mark', () => {
      const { rows, missing } = buildCatalogRows(
        withMutation([queryLeaf('debug.ping')]),
        new Map([['debug.ping', 'Pings the debug router.']])
      );
      const row = rows[0];
      // The fixture's own leaves are published; the mutation added to satisfy
      // the drift guard carries no summary, so it waits for the LLM pass.
      expect(missing.map(leaf => leaf.path)).toEqual(['user.updateProfile']);
      expect(row?.debug).toBe(true);
      expect(row).not.toHaveProperty('admin');
      // Key order stays deterministic for the dump's byte-for-byte check.
      expect(Object.keys(row ?? {})).toEqual([
        'path',
        'kind',
        'summary',
        'inputSchema',
        'tags',
        'searchBlob',
        'debug',
      ]);
    });

    it('marks an admin-guarded debug procedure with both marks', () => {
      const { rows } = buildCatalogRows(
        withMutation([queryLeaf('debug.badInputError')]),
        new Map([['debug.badInputError', 'Echoes a short string back from the debug router.']])
      );
      const row = rows[0];
      expect(row?.debug).toBe(true);
      expect(row?.admin).toBe(true);
      // Both marks are emitted at the tail in a fixed order, admin first.
      expect(Object.keys(row ?? {})).toEqual([
        'path',
        'kind',
        'summary',
        'inputSchema',
        'tags',
        'searchBlob',
        'admin',
        'debug',
      ]);
    });

    it('still drops an admin leaf', () => {
      const { rows, missing } = buildCatalogRows(
        withMutation([queryLeaf('admin.users.list'), queryLeaf('user.getProfile')]),
        new Map([
          ['admin.users.list', 'Lists users.'],
          ['user.getProfile', 'Returns the profile of a user.'],
        ])
      );
      expect(rows.map(row => row.path)).toEqual(['user.getProfile']);
      expect(missing.map(leaf => leaf.path)).toEqual(['user.updateProfile']);
    });

    it('still drops a test leaf', () => {
      const { rows, missing } = buildCatalogRows(
        withMutation([queryLeaf('test.echo'), queryLeaf('user.getProfile')]),
        new Map([
          ['test.echo', 'Echoes a payload.'],
          ['user.getProfile', 'Returns the profile of a user.'],
        ])
      );
      expect(rows.map(row => row.path)).toEqual(['user.getProfile']);
      expect(missing.map(leaf => leaf.path)).toEqual(['user.updateProfile']);
    });
  });

  describe('procedureRequiresAdmin', () => {
    const cases: Array<[string | null, boolean]> = [
      ['adminProcedure.input(z.object({})).query(async () => ({}))', true],
      ['creditManagerProcedure.query(async () => ({}))', true],
      ['superadminProcedure.query(async () => ({}))', true],
      ['sessionViewerProcedure.query(async () => ({}))', true],
      ['baseProcedure.query(async () => ({}))', false],
      ['protectedProcedure.query(async () => ({}))', false],
      // A guard elsewhere in the chain does not make the procedure admin-only.
      ['baseProcedure.use(adminProcedure).query(async () => ({}))', false],
      ['notAdminProcedure.query(async () => ({}))', false],
      [null, false],
    ];

    it.each(cases)('treats %s as admin-guarded: %s', (source, expected) => {
      expect(procedureRequiresAdmin(source)).toBe(expected);
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
        withMutation([queryLeaf('b.b'), queryLeaf('a.a')]),
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

    it('publishes every non-denylisted mutation with kind mutation and a searchable blob', () => {
      const catalog = JSON.parse(readFileSync(CATALOG_JSON_PATH, 'utf8')) as Record<
        string,
        { kind?: string; searchBlob?: string } | undefined
      >;
      const expected = collectCatalogLeaves(rootRouter)
        .filter(leaf => leaf.type === 'mutation' && !isDenylistedPath(leaf.path))
        .map(leaf => leaf.path);
      expect(expected.length).toBeGreaterThan(0);
      for (const path of expected) {
        expect(catalog[path]?.kind).toBe('mutation');
        expect(catalog[path]?.searchBlob).toContain(path);
      }
    });

    it('publishes every required field of a chained-input mutation', () => {
      // workspaceFolders.create chains a second .input() requiring name/color;
      // a first-input-only catalog advertises organizationId alone and lets an
      // MCP request pass local validation before failing upstream.
      const catalog = JSON.parse(readFileSync(CATALOG_JSON_PATH, 'utf8')) as Record<
        string,
        { inputSchema?: Record<string, unknown> } | undefined
      >;
      const schema = catalog['workspaceFolders.create']?.inputSchema;
      const required = Array.isArray(schema?.['required']) ? (schema['required'] as string[]) : [];
      const properties = Object.keys((schema?.['properties'] as object) ?? {});
      expect(required).toEqual(expect.arrayContaining(['organizationId', 'name', 'color']));
      expect(properties).toEqual(expect.arrayContaining(['organizationId', 'name', 'color']));
    });
  });

  describe('generateMissingSummaries', () => {
    const failingComplete = jest.fn(() => {
      throw new Error('the summary completer must not be called');
    });

    it('resolves immediately when nothing is missing', async () => {
      await expect(generateMissingSummaries([], failingComplete)).resolves.toEqual(new Map());
      expect(failingComplete).not.toHaveBeenCalled();
    });

    it('fails without retry when the Kilo CLI is not installed, naming the self-service path', () => {
      const previous = process.env.KILO_BIN;
      process.env.KILO_BIN = 'kilo-does-not-exist-xyz';
      try {
        expect(() => runKiloCompletion('prompt', 'usage-analytics-router.ts')).toThrow(
          /not found on PATH/
        );
        try {
          runKiloCompletion('prompt', 'usage-analytics-router.ts');
        } catch (error) {
          // Fork PRs never get CI credentials, so the error must also name the
          // credential-free self-service path (requirement 6's guidance).
          expect(error).toMatchObject({ retryable: false });
          expect((error as Error).message).toMatch(
            /hand-write a summary for each new path in services\/kilo-mcp\/catalog\.json/
          );
        }
      } finally {
        if (previous === undefined) delete process.env.KILO_BIN;
        else process.env.KILO_BIN = previous;
      }
    });

    it('parses the assistant text out of the Kilo CLI JSON event stream', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kilo-summary-'));
      const bin = join(dir, 'fake-kilo');
      writeFileSync(
        bin,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"step_start","part":{"type":"step-start"}}' '{"type":"text","part":{"type":"text","text":"{\\"usageAnalytics.probe\\":\\"ok\\"}","time":{"end":1}}}'\n`,
        { mode: 0o755 }
      );
      const previous = process.env.KILO_BIN;
      process.env.KILO_BIN = bin;
      try {
        expect(runKiloCompletion('prompt', 'usage-analytics-router.ts')).toBe(
          '{"usageAnalytics.probe":"ok"}'
        );
      } finally {
        if (previous === undefined) delete process.env.KILO_BIN;
        else process.env.KILO_BIN = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('takes only completed text events, ignoring in-progress streaming deltas', () => {
      // Same contract as services/auto-routing-benchmark/src/kilo-events.ts.
      // Concatenating the deltas would garble the JSON the dump has to parse.
      expect(
        parseKiloCompletion([
          JSON.stringify({
            type: 'text',
            part: { type: 'text', text: '{"a"', time: { start: 1 } },
          }),
          JSON.stringify({
            type: 'text',
            part: { type: 'text', text: '{"a":1}', time: { end: 2 } },
          }),
        ])
      ).toBe('{"a":1}');
    });

    it('accepts the flattened top-level event shape', () => {
      expect(
        parseKiloCompletion([JSON.stringify({ type: 'text', text: '{"a":1}', time: { end: 2 } })])
      ).toBe('{"a":1}');
    });

    it('skips malformed lines without throwing', () => {
      expect(
        parseKiloCompletion([
          'not json',
          '',
          '{ broken',
          JSON.stringify({ type: 'text', part: { type: 'text', text: 'x', time: { end: 1 } } }),
        ])
      ).toBe('x');
    });

    it('marks a non-zero Kilo CLI exit as retryable and names the failed batch', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kilo-summary-'));
      const bin = join(dir, 'fake-kilo');
      writeFileSync(
        bin,
        `#!/bin/sh\ncat > /dev/null\nprintf 'upstream unavailable\\n' >&2\nexit 1\n`,
        {
          mode: 0o755,
        }
      );
      const previous = process.env.KILO_BIN;
      process.env.KILO_BIN = bin;
      try {
        expect(() => runKiloCompletion('prompt', 'usage-analytics-router.ts')).toThrow(
          /usage-analytics-router\.ts/
        );
        try {
          runKiloCompletion('prompt', 'usage-analytics-router.ts');
        } catch (error) {
          expect(error).toMatchObject({ retryable: true });
        }
      } finally {
        if (previous === undefined) delete process.env.KILO_BIN;
        else process.env.KILO_BIN = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('marks a signed-out Kilo CLI as non-retryable', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kilo-summary-'));
      const bin = join(dir, 'fake-kilo');
      writeFileSync(
        bin,
        `#!/bin/sh\ncat > /dev/null\nprintf 'Error: You need to sign in\\n' >&2\nexit 1\n`,
        {
          mode: 0o755,
        }
      );
      const previous = process.env.KILO_BIN;
      process.env.KILO_BIN = bin;
      try {
        try {
          runKiloCompletion('prompt', 'usage-analytics-router.ts');
          throw new Error('expected runKiloCompletion to throw');
        } catch (error) {
          expect(error).toMatchObject({ retryable: false });
        }
      } finally {
        if (previous === undefined) delete process.env.KILO_BIN;
        else process.env.KILO_BIN = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('batches one completion per router file and parses the summaries', async () => {
      const calls: Array<{ label: string; prompt: string }> = [];
      const complete = jest.fn((prompt: string, label: string) => {
        calls.push({ label, prompt });
        // Echo one summary per procedure the batch requested.
        const out: Record<string, string> = {};
        for (const match of prompt.matchAll(/^- ([A-Za-z0-9_.]+)$/gm))
          out[match[1]!] = `Summary for ${match[1]}.`;
        return JSON.stringify(out);
      });

      const summaries = await generateMissingSummaries(
        [queryLeaf('usageAnalytics.probe'), queryLeaf('kiloChat.probe')],
        complete
      );
      expect(summaries.get('usageAnalytics.probe')).toBe('Summary for usageAnalytics.probe.');
      expect(summaries.get('kiloChat.probe')).toBe('Summary for kiloChat.probe.');
      expect(calls).toHaveLength(2); // one per router file, batched
      expect(calls[0]?.prompt).toContain(SUMMARY_INSTRUCTION);
      expect(calls[0]?.prompt).toContain('usageAnalytics.probe');
    });

    it('logs a progress line naming each router-file batch as it starts', async () => {
      const events: string[] = [];
      const complete = jest.fn((prompt: string) => {
        events.push('complete');
        const out: Record<string, string> = {};
        for (const match of prompt.matchAll(/^- ([A-Za-z0-9_.]+)$/gm))
          out[match[1]!] = `Summary for ${match[1]}.`;
        return JSON.stringify(out);
      });

      await generateMissingSummaries(
        [queryLeaf('usageAnalytics.probe'), queryLeaf('kiloChat.probe')],
        complete,
        message => events.push(message)
      );
      // Each batch is named (router file + count) before its request starts.
      expect(events).toEqual([
        expect.stringContaining('usage-analytics-router.ts'),
        'complete',
        expect.stringContaining('kilo-chat-router.ts'),
        'complete',
      ]);
      expect(events[0]).toContain('1/2');
      expect(events[0]).toContain('1 summary');
      expect(events[2]).toContain('2/2');
    });

    it('rejects unusable model output as non-retryable', async () => {
      const complete = jest.fn(() => '{"some.other.path": "wrong key"}');

      await expect(
        generateMissingSummaries([queryLeaf('usageAnalytics.probe')], complete)
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining('usageAnalytics.probe'),
      });
    });

    it('extracts the enclosing handler source for a real procedure', async () => {
      const prompts: string[] = [];
      const complete = jest.fn((prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({
          'usageAnalytics.getSummary': 'Returns aggregate usage KPI metrics.',
        });
      });

      await generateMissingSummaries([queryLeaf('usageAnalytics.getSummary')], complete);
      const content = prompts[0] ?? '';
      // The extracted block should include the real handler, not just the path.
      expect(content).toMatch(/getSummary/);
      expect(content.length).toBeGreaterThan(200);
    });
  });
});
