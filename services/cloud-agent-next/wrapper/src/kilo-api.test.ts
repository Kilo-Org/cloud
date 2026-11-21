import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import type { QuestionRequest } from '@kilocode/sdk/v2';
import {
  createWrapperKiloClient,
  KILO_ACTIVITY_DISCOVERY_LIMIT,
  KILO_ACTIVITY_MESSAGE_LIMIT,
  DrainSessionError,
  isKiloServerUnreachableError,
  forgetOutstandingRuleset,
  readOutstandingRuleset,
  rememberOutstandingRuleset,
  SessionRulesetError,
  SessionRulesetNotAppliedError,
  SessionRulesetUnverifiedError,
  type WrapperKiloClient,
} from './kilo-api';

describe('isKiloServerUnreachableError', () => {
  it('matches a raw ECONNREFUSED error', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5173'), {
      code: 'ECONNREFUSED',
    });
    expect(isKiloServerUnreachableError(error)).toBe(true);
  });

  it('matches a fetch TypeError whose cause carries the network error code', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const error = new Error('fetch failed', { cause });
    expect(isKiloServerUnreachableError(error)).toBe(true);
  });

  it('matches common Bun/undici connection-refused message text without a code', () => {
    expect(
      isKiloServerUnreachableError(new Error('Unable to connect. Is the server running?'))
    ).toBe(true);
    expect(isKiloServerUnreachableError(new Error('fetch failed'))).toBe(true);
  });

  it('matches ECONNRESET and EPIPE', () => {
    expect(
      isKiloServerUnreachableError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      )
    ).toBe(true);
    expect(
      isKiloServerUnreachableError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).toBe(true);
  });

  it('matches Bun fetch connection codes', () => {
    expect(
      isKiloServerUnreachableError(
        Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
          code: 'ConnectionRefused',
        })
      )
    ).toBe(true);
  });

  it('matches a wrapped SDK transport failure through its cause', () => {
    const transport = Object.assign(
      new Error('Unable to connect. Is the computer able to access the url?'),
      { code: 'ConnectionRefused' }
    );
    expect(
      isKiloServerUnreachableError(
        new Error('Command for session ses_123 failed: Unable to connect.', { cause: transport })
      )
    ).toBe(true);
  });

  it('does not match a live-server application error whose body mentions a fetch failure', () => {
    // A live kilo server relaying an upstream failure: the parsed response body
    // (a plain object, not an Error) is attached as cause by the wrapper.
    expect(
      isKiloServerUnreachableError(
        new Error('Async prompt for session ses_123 failed: upstream fetch failed: provider 502', {
          cause: { message: 'upstream fetch failed: provider 502' },
        })
      )
    ).toBe(false);
  });

  it('never pattern-matches the composed message of an error that carries a cause', () => {
    expect(
      isKiloServerUnreachableError(
        new Error('Command for session ses_123 failed: fetch failed', {
          cause: new Error('application rejected the command'),
        })
      )
    ).toBe(false);
  });

  it('does not match application-level errors from a live server', () => {
    expect(
      isKiloServerUnreachableError(new Error('Session get returned no data for ses_123'))
    ).toBe(false);
    expect(
      isKiloServerUnreachableError(
        new Error('Async prompt for session ses_123 failed: invalid model')
      )
    ).toBe(false);
  });

  it('does not match non-Error values', () => {
    expect(isKiloServerUnreachableError('ECONNREFUSED')).toBe(false);
    expect(isKiloServerUnreachableError(undefined)).toBe(false);
    expect(isKiloServerUnreachableError(null)).toBe(false);
  });
});

describe('createWrapperKiloClient generated SDK HTTP boundary', () => {
  type RecordedRequest = {
    method: string;
    pathname: string;
    directory: string | null;
    body: unknown;
  };

  const startedServers: ReturnType<typeof Bun.serve>[] = [];

  afterEach(async () => {
    await Promise.all(startedServers.splice(0).map(server => server.stop()));
  });

  function startStub(
    status: number,
    body: unknown = true
  ): { url: string; requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async req => {
        const url = new URL(req.url);
        requests.push({
          method: req.method,
          pathname: url.pathname,
          directory: url.searchParams.get('directory'),
          body: req.body ? await req.json() : undefined,
        });
        return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
      },
    });
    startedServers.push(server);
    return { url: server.url.toString(), requests };
  }

  function createClient(serverUrl: string) {
    return createWrapperKiloClient(
      createKiloClient({ baseUrl: serverUrl }),
      { url: serverUrl },
      '/workspace'
    );
  }

  it('replaces the running CLI MCP connection using the generated directory-scoped SDK API', async () => {
    const stub = startStub(200, { 'kilo-cloud-agent': { status: 'connected' } });
    await createClient(stub.url).updateCloudAgentMcp({
      url: 'https://mcp.kiloapps.io/mcp',
      token: 'renewed-session-mcp-token',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    });
    expect(stub.requests).toEqual([
      {
        method: 'POST',
        pathname: '/mcp',
        directory: '/workspace',
        body: {
          name: 'kilo-cloud-agent',
          config: {
            type: 'remote',
            url: 'https://mcp.kiloapps.io/mcp',
            oauth: false,
            headers: { Authorization: 'Bearer renewed-session-mcp-token' },
          },
        },
      },
    ]);
  });

  it('does not leak scoped MCP credentials in configuration refresh failures', async () => {
    const stub = startStub(400, { message: 'private-scoped-mcp-token' });
    const error: unknown = await createClient(stub.url)
      .updateCloudAgentMcp({
        url: 'https://mcp.kiloapps.io/mcp',
        token: 'private-scoped-mcp-token',
        expiresAt: 123,
      })
      .catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected credential refresh failure');
    expect(error.message).toBe('Cloud Agent MCP credential refresh failed');
    expect(stub.requests).toHaveLength(2);
  });

  it.each(['failed', 'needs_auth', 'disabled'])(
    'rejects an HTTP-successful but unavailable MCP status %s after bounded retry',
    async status => {
      const stub = startStub(200, {
        'kilo-cloud-agent': { status, error: 'private-scoped-mcp-token' },
      });
      const error: unknown = await createClient(stub.url)
        .updateCloudAgentMcp({
          url: 'https://mcp.kiloapps.io/mcp',
          token: 'private-scoped-mcp-token',
          expiresAt: 123,
        })
        .catch(cause => cause);
      expect(error).toMatchObject({ message: 'Cloud Agent MCP credential refresh failed' });
      expect(stub.requests).toHaveLength(2);
    }
  );

  it('retries a transient MCP connection failure without changing the issued credential', async () => {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        attempts++;
        return Response.json({
          'kilo-cloud-agent': { status: attempts === 1 ? 'failed' : 'connected' },
        });
      },
    });
    startedServers.push(server);
    await createClient(server.url.toString()).updateCloudAgentMcp({
      url: 'https://mcp.kiloapps.io/mcp',
      token: 'renewed-session-mcp-token',
      expiresAt: 123,
    });
    expect(attempts).toBe(2);
  });

  it('discovers directory and ancestry across the process without retaining session history', async () => {
    let query: URL | undefined;
    let header: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        query = new URL(request.url);
        header = request.headers.get('x-kilo-directory');
        return Response.json([
          {
            id: 'ses_child',
            directory: '/another',
            parentID: 'ses_parent',
            title: 'private title',
            metadata: { secret: 'private' },
          },
        ]);
      },
    });
    startedServers.push(server);
    const sessions = await createClient(server.url.toString()).listSessionMetadata(
      AbortSignal.timeout(1000)
    );
    expect(sessions).toEqual([{ id: 'ses_child', directory: '/another', parentID: 'ses_parent' }]);
    expect(query?.pathname).toBe('/experimental/session');
    expect(query?.searchParams.get('directory')).toBeNull();
    expect(header).toBeNull();
    expect(query?.searchParams.get('limit')).toBe(String(KILO_ACTIVITY_DISCOVERY_LIMIT));
    expect(query?.searchParams.get('archived')).toBe('true');
  });

  it('rejects incomplete discovery instead of silently treating undiscovered directories as idle', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json([], { headers: { 'x-next-cursor': '123' } }),
    });
    startedServers.push(server);
    const error = await createClient(server.url.toString())
      .listSessionMetadata(AbortSignal.timeout(1000))
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Activity session discovery exceeded its bounded complete window',
    });
  });

  it('bounds activity message reads and passes the owned directory and cancellation signal', async () => {
    let query: URL | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        query = new URL(request.url);
        return Response.json([]);
      },
    });
    startedServers.push(server);
    await createClient(server.url.toString()).getRecentSessionMessages(
      'ses_1',
      '/other',
      AbortSignal.timeout(1000)
    );
    expect(query?.pathname).toBe('/session/ses_1/message');
    expect(query?.searchParams.get('directory')).toBe('/other');
    expect(query?.searchParams.get('limit')).toBe(String(KILO_ACTIVITY_MESSAGE_LIMIT));
    const controller = new AbortController();
    controller.abort();
    const error = await createClient(server.url.toString())
      .getRecentSessionMessages('ses_1', '/other', controller.signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: 'Activity session messages failed: request error' });
  });

  it('keeps skill-sourced rows in the catalog so the composer can list and invoke them', async () => {
    const stub = startStub(200, [
      { name: 'review', description: 'Review', hints: [], source: 'command', template: 'x' },
      {
        name: 'kilo-config',
        description: 'Guide for Kilo configuration',
        hints: [],
        source: 'skill',
        template: 'y',
      },
    ]);

    const catalog = await createClient(stub.url).listCommands();

    expect(catalog).toEqual({
      commands: [
        { name: 'review', description: 'Review', source: 'command', hints: [] },
        {
          name: 'kilo-config',
          description: 'Guide for Kilo configuration',
          source: 'skill',
          hints: [],
        },
      ],
      dropped: 0,
      overLimit: false,
    });
  });

  it('keeps every skill row when a full catalog is bounded', async () => {
    const stub = startStub(200, [
      ...Array.from({ length: 260 }, (_, index) => ({
        name: `cmd-${index}`,
        description: 'Command',
        hints: [],
        source: 'command',
        template: 'x',
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `skill-${index}`,
        description: 'Guide',
        hints: [],
        source: 'skill',
        template: 'y',
      })),
    ]);

    const catalog = await createClient(stub.url).listCommands();

    expect(catalog.commands).toHaveLength(256);
    expect(catalog.commands.filter(command => command.source === 'skill')).toEqual([
      { name: 'skill-0', description: 'Guide', source: 'skill', hints: [] },
      { name: 'skill-1', description: 'Guide', source: 'skill', hints: [] },
      { name: 'skill-2', description: 'Guide', source: 'skill', hints: [] },
    ]);
    // 260 non-skill rows plus 3 skill rows against a 256-command bound: the
    // skill rows survive and 7 non-skill rows do not.
    expect(catalog.dropped).toBe(7);
    expect(catalog.overLimit).toBe(false);
  });

  it('reports the full catalog when skill rows alone exceed a bound', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kilo-api-catalog-'));
    const logPath = join(directory, 'wrapper.log');
    const originalLogPath = process.env.WRAPPER_LOG_PATH;
    process.env.WRAPPER_LOG_PATH = logPath;
    try {
      const stub = startStub(
        200,
        Array.from({ length: 300 }, (_, index) => ({
          name: `skill-${index}`,
          description: 'Guide',
          hints: [],
          source: 'skill',
          template: 'y',
        }))
      );

      const catalog = await createClient(stub.url).listCommands();

      // Skill rows are never truncated: the over-limit catalog is returned as
      // the CLI reported it, and the wrapper says so instead of hiding skills.
      expect(catalog.commands).toHaveLength(300);
      expect(catalog.dropped).toBe(0);
      expect(catalog.overLimit).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toContain('slash command catalog over limit');
    } finally {
      if (originalLogPath === undefined) delete process.env.WRAPPER_LOG_PATH;
      else process.env.WRAPPER_LOG_PATH = originalLogPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const questions: QuestionRequest[] = [
    {
      id: 'question_1',
      sessionID: 'ses_1',
      questions: [
        {
          question: 'Which changes should be applied?',
          header: 'Changes',
          options: [
            {
              label: 'All',
              description: 'Apply every change',
              labelKey: 'all',
              descriptionKey: 'applyAll',
              mode: 'code',
            },
          ],
          multiple: true,
          custom: false,
          questionKey: 'changesQuestion',
          headerKey: 'changesHeader',
        },
      ],
      blocking: true,
      tool: { messageID: 'msg_1', callID: 'call_1' },
    },
  ];

  const operations: Array<{
    name: string;
    method: string;
    pathname: string;
    response: unknown;
    body?: unknown;
    invoke: (client: WrapperKiloClient, directory?: string) => Promise<unknown>;
  }> = [
    {
      name: 'abort',
      method: 'POST',
      pathname: '/session/ses_1/abort',
      response: true,
      invoke: (client, directory) => client.abortSession({ sessionId: 'ses_1', directory }),
    },
    {
      name: 'session summarize',
      method: 'POST',
      pathname: '/session/ses_1/summarize',
      response: true,
      body: { providerID: 'kilo', modelID: 'vendor/Team/Model:free~Alias' },
      invoke: (client, directory) =>
        client.summarizeSession({
          sessionId: 'ses_1',
          model: { modelID: 'vendor/Team/Model:free~Alias' },
          directory,
        }),
    },
    {
      name: 'question answer',
      method: 'POST',
      pathname: '/question/question_1/reply',
      response: true,
      body: { answers: [['All']] },
      invoke: (client, directory) => client.answerQuestion('question_1', [['All']], directory),
    },
    {
      name: 'question rejection',
      method: 'POST',
      pathname: '/question/question_1/reject',
      response: true,
      invoke: (client, directory) => client.rejectQuestion('question_1', directory),
    },
    {
      name: 'permission reply',
      method: 'POST',
      pathname: '/permission/perm_1/reply',
      response: true,
      body: { reply: 'once', message: 'approved', interactive: true },
      invoke: (client, directory) =>
        client.answerPermission('perm_1', 'once', 'approved', true, directory),
    },
    {
      name: 'session status',
      method: 'GET',
      pathname: '/session/status',
      response: { ses_1: { type: 'busy' } },
      invoke: (client, directory) => client.getSessionStatuses(directory),
    },
    {
      name: 'session diff',
      method: 'GET',
      pathname: '/session/ses_1/diff',
      response: [
        {
          file: 'src/file.ts',
          patch:
            'diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-before\n+after\n',
          additions: 1,
          deletions: 1,
          status: 'modified',
        },
      ],
      invoke: (client, directory) => client.getSessionDiff('ses_1', directory),
    },
    {
      name: 'question list',
      method: 'GET',
      pathname: '/question',
      response: questions,
      invoke: (client, directory) => client.getQuestions(directory),
    },
    {
      name: 'permission list',
      method: 'GET',
      pathname: '/permission',
      response: [
        {
          id: 'perm_1',
          sessionID: 'ses_1',
          permission: 'bash',
          patterns: ['ls'],
          metadata: { skill: 'review' },
          always: ['ls *'],
          tool: { messageID: 'msg_1', callID: 'call_1' },
        },
      ],
      invoke: (client, directory) => client.getPermissions(directory),
    },
  ];

  for (const operation of operations) {
    for (const directory of [undefined, '/workspace/attached repo & tests']) {
      it(`${operation.name} serializes ${directory ? 'attached' : 'default'} directory and preserves its response`, async () => {
        const stub = startStub(200, operation.response);
        const client = createClient(stub.url);

        expect(await operation.invoke(client, directory)).toEqual(operation.response);
        expect(stub.requests).toEqual([
          {
            method: operation.method,
            pathname: operation.pathname,
            directory: directory ?? '/workspace',
            body: operation.body,
          },
        ]);
      });
    }

    it(`${operation.name} rejects missing required response data`, async () => {
      const stub = startStub(204);
      const error: unknown = await operation.invoke(createClient(stub.url)).catch(cause => cause);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected missing response failure');
      expect(error.message).toContain('returned no data');
    });

    if (operation.response === true) {
      it(`${operation.name} preserves a negative acknowledgement`, async () => {
        const stub = startStub(200, false);
        expect(await operation.invoke(createClient(stub.url))).toBe(false);
      });
    }
  }

  it('reads directory-scoped status without treating another checkout as empty', async () => {
    const directory = '/workspace/shared checkout & tools';
    const requests: Array<{ method: string; pathname: string; directory: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: request => {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          pathname: url.pathname,
          directory: url.searchParams.get('directory'),
        });
        return Response.json(
          url.searchParams.get('directory') === directory
            ? { root_a: { type: 'busy', waitingOn: 'tool' } }
            : {}
        );
      },
    });
    startedServers.push(server);
    const client = createClient(server.url.toString());

    expect(await client.getSessionStatuses(directory)).toEqual({
      root_a: { type: 'busy', waitingOn: 'tool' },
    });
    expect(requests).toEqual([{ method: 'GET', pathname: '/session/status', directory }]);
    expect(await client.getSessionStatuses()).toEqual({});
  });

  it('rejects a non-boolean abort acknowledgement', async () => {
    const stub = startStub(200, {});
    const error: unknown = await createClient(stub.url)
      .abortSession({ sessionId: 'ses_1' })
      .catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected invalid abort response failure');
    expect(error.message).toBe('Session abort for ses_1 returned no boolean result');
  });

  it('treats a 404 cleanup abort as success without retrying', async () => {
    const stub = startStub(404, {});
    await createClient(stub.url).abortSessionForCleanup({
      sessionId: 'ses_1',
      directory: '/workspace',
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      pathname: '/session/ses_1/abort',
      directory: '/workspace',
    });
  });

  it('validates cleanup child rows before walking them', async () => {
    const valid = 'ses_22222222222222222222222222';
    const good = startStub(200, [{ id: valid, directory: '/workspace' }]);
    expect(
      await createClient(good.url).children({ sessionId: 'ses_1', directory: '/workspace' })
    ).toEqual([{ id: valid, directory: '/workspace' }]);

    const malformed = startStub(200, [{ id: 'not-a-session', directory: '/workspace' }]);
    const error: unknown = await createClient(malformed.url)
      .children({ sessionId: 'ses_1', directory: '/workspace' })
      .catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
  });

  const errorOperations: Array<{
    name: string;
    invoke: (client: WrapperKiloClient) => Promise<unknown>;
  }> = [
    ...operations,
    { name: 'session create', invoke: client => client.createSession() },
    { name: 'session get', invoke: client => client.getSession('ses_1') },
    {
      name: 'session ensure',
      invoke: client => client.ensureSession('ses_1', '/workspace/attached'),
    },
    {
      name: 'prompt completion',
      invoke: client =>
        client.sendPrompt({ sessionId: 'ses_1', messageId: 'msg_1', prompt: 'hello' }),
    },
    {
      name: 'async prompt',
      invoke: client =>
        client.sendPromptAsync({ sessionId: 'ses_1', messageId: 'msg_1', prompt: 'hello' }),
    },
    {
      name: 'command completion',
      invoke: client => client.sendCommand({ sessionId: 'ses_1', command: 'review' }),
    },
    { name: 'command list', invoke: client => client.listCommands() },
    { name: 'network list', invoke: client => client.getNetworkWaits() },
    { name: 'network reply', invoke: client => client.resumeNetworkWait('net_1') },
    { name: 'model list', invoke: client => client.listEffectiveModels('kilo') },
    {
      name: 'commit message generation',
      invoke: client => client.generateCommitMessage({ path: '/workspace' }),
    },
    {
      name: 'PTY create',
      invoke: client => client.createPty({ cwd: '/workspace', title: 'Terminal', env: {} }),
    },
    { name: 'PTY resize', invoke: client => client.resizePty('pty_1', { cols: 80, rows: 24 }) },
    { name: 'PTY delete', invoke: client => client.deletePty('pty_1') },
  ];

  for (const operation of errorOperations) {
    it(`${operation.name} rejects an HTTP failure without exposing the SDK error body`, async () => {
      const stub = startStub(500, {
        message: 'upstream fetch failed with sensitive response data',
        credentials: 'private test value',
      });
      const error: unknown = await operation.invoke(createClient(stub.url)).catch(cause => cause);

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected SDK failure');
      expect(error.message).toMatch(/failed: HTTP 500$/);
      expect(error.message).not.toContain('sensitive');
      expect(error.message).not.toContain('private test value');
      expect(isKiloServerUnreachableError(error)).toBe(false);
      expect(stub.requests).toHaveLength(1);
    });
  }

  it('aborts an in-flight commit-message HTTP request without waiting for a response', async () => {
    const received = Promise.withResolvers<IncomingMessage>();
    const server = createServer(request => {
      request.resume();
      received.resolve(request);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();
    const reason = new Error('Task cancelled');
    const watchdog = setTimeout(() => server.closeAllConnections(), 1_000);
    try {
      const pending = createClient(serverUrl)
        .generateCommitMessage({ path: '/workspace', signal: controller.signal })
        .catch((error: unknown) => error);
      const request = await received.promise;
      expect(request.method).toBe('POST');
      const url = new URL(request.url ?? '', serverUrl);
      expect(url.pathname).toBe('/commit-message');
      expect(url.searchParams.get('directory')).toBe('/workspace');

      controller.abort(reason);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected cancellation failure');
      expect(error.cause).toBe(reason);
      expect(error.message).toBe('Commit message generation failed: request error');
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('imports a missing session into its native directory project without requiring a global project row', async () => {
    const sessionId = 'ses_fba796140fffo6EPOZajyerVqP';
    const projectId = '57ccd1e3429a492e139d0882b4767d0830996221';
    const directory = '/workspace/attached repo & tests';
    const database = new Database(':memory:');
    database.run('PRAGMA foreign_keys = ON');
    database.run('CREATE TABLE project (id TEXT PRIMARY KEY)');
    database.run(
      'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), directory TEXT NOT NULL)'
    );
    database.run('INSERT INTO project (id) VALUES (?)', [projectId]);
    const requests: Array<{ method: string; pathname: string; directory: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          pathname: url.pathname,
          directory: url.searchParams.get('directory'),
        });
        if (url.searchParams.get('directory') !== directory)
          return new Response(null, { status: 400 });
        if (request.method === 'GET' && url.pathname === `/session/${sessionId}`) {
          const row = database
            .query<{ id: string; projectID: string; directory: string }, [string]>(
              'SELECT id, project_id AS projectID, directory FROM session WHERE id = ?'
            )
            .get(sessionId);
          return row
            ? Response.json(row)
            : Response.json(
                { name: 'NotFoundError', data: { message: `Session not found: ${sessionId}` } },
                { status: 404 }
              );
        }
        if (url.pathname === '/project/current') {
          return Response.json({
            id: projectId,
            worktree: directory,
            vcs: 'git',
            time: { created: 1, updated: 1 },
            sandboxes: [],
          });
        }
        if (request.method === 'POST' && url.pathname === '/kilocode/session-import/session') {
          const body = (await request.json()) as {
            id: string;
            projectID: string;
            directory: string;
          };
          try {
            database.run('INSERT INTO session (id, project_id, directory) VALUES (?, ?, ?)', [
              body.id,
              body.projectID,
              body.directory,
            ]);
          } catch {
            return Response.json(
              {
                name: 'UnknownError',
                data: { message: 'Unexpected server error. Check server logs for details.' },
              },
              { status: 500 }
            );
          }
          return Response.json({ ok: true, id: body.id });
        }
        if (request.method === 'POST' && url.pathname === `/session/${sessionId}/abort`)
          return Response.json(true);
        return new Response(null, { status: 404 });
      },
    });
    try {
      const url = server.url.toString();
      const client = createWrapperKiloClient(
        createKiloClient({ baseUrl: url }),
        { url },
        directory
      );
      await client.ensureSession(sessionId, directory);
      expect(await client.getSession(sessionId)).toEqual({ id: sessionId });
      expect(await client.abortSession({ sessionId, directory })).toBe(true);
      await client.ensureSession(sessionId, directory);
      expect(database.query('SELECT id FROM project WHERE id = ?').get('global')).toBeNull();
      expect(
        database.query('SELECT id, project_id AS projectID, directory FROM session').all()
      ).toEqual([{ id: sessionId, projectID: projectId, directory }]);
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
        `GET /session/${sessionId}`,
        'GET /project/current',
        'POST /kilocode/session-import/session',
        `GET /session/${sessionId}`,
        `POST /session/${sessionId}/abort`,
        `GET /session/${sessionId}`,
      ]);
      expect(requests.every(request => request.directory === directory)).toBe(true);
    } finally {
      await server.stop(true);
      database.close();
    }
  });

  it.each([
    { status: 500, body: { message: 'private fake diagnostic' } },
    { status: 200, body: {} },
    { status: 200, body: { id: '' } },
  ])(
    'does not import a session when current project lookup is invalid: %j',
    async ({ status, body }) => {
      let imports = 0;
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/project/current') return Response.json(body, { status });
          if (request.method === 'POST') imports += 1;
          return Response.json(
            { name: 'NotFoundError', data: { message: 'Session not found' } },
            { status: 404 }
          );
        },
      });
      try {
        const error: unknown = await createClient(server.url.toString())
          .ensureSession('ses_1', '/workspace/attached')
          .catch(error => error);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error('Expected project lookup failure');
        expect(error.message).toContain('project');
        expect(error.message).not.toContain('private fake diagnostic');
        expect(imports).toBe(0);
      } finally {
        await server.stop(true);
      }
    }
  );

  describe('ensureSession rebinding', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    function temporaryDirectory(prefix: string): string {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      temporaryDirectories.push(directory);
      return directory;
    }

    // The SDK maps `query_directory` onto the `directory` query parameter and
    // `body_directory` onto the `directory` body field, so the wire request is
    // what the wrapper's argument turns into.
    type EnsureSessionRecord = {
      id: string;
      slug?: string;
      directory: string;
      title?: string;
      workspaceID?: string;
      parentID?: string;
      share?: { url: string } | null;
      summary?: {
        additions: number;
        deletions: number;
        files: number;
        diffs?: Array<Record<string, unknown>>;
      };
      revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
      permission?: unknown;
      metadata?: Record<string, unknown>;
      time?: { created: number; updated: number; compacting?: number; archived?: number };
    };

    type EnsureSessionImport = {
      queryDirectory: string | null;
      body: {
        id?: string;
        force?: boolean;
        directory?: string;
        projectID?: string;
        slug?: string;
        title?: string;
        workspaceID?: string;
        parentID?: string;
        shareURL?: string;
        summary?: EnsureSessionRecord['summary'];
        revert?: EnsureSessionRecord['revert'];
        timeCreated?: number;
        timeUpdated?: number;
        timeCompacting?: number;
        timeArchived?: number;
      };
    };

    type EnsureSessionUpdate = {
      queryDirectory: string | null;
      body: {
        permission?: EnsureSessionRecord['permission'];
        metadata?: EnsureSessionRecord['metadata'];
      };
    };

    function startEnsureSessionStub(
      sessionId: string,
      record?: EnsureSessionRecord,
      options: {
        failUpdates?: number;
        updateStatus?: number;
        metadataUpdateStatus?: number;
        getFailures?: number;
        onImport?: () => void;
        onPermissionUpdate?: () => void;
      } = {}
    ): { url: string; imports: EnsureSessionImport[]; updates: EnsureSessionUpdate[] } {
      const imports: EnsureSessionImport[] = [];
      const updates: EnsureSessionUpdate[] = [];
      let updatesToFail = options.failUpdates ?? 0;
      let getsToFail = options.getFailures ?? 0;
      // The native import replaces the row, cannot carry a ruleset or metadata,
      // and the update appends rules instead of replacing them while replacing
      // metadata wholesale.
      let storedPermission = record?.permission;
      let storedMetadata = record?.metadata;
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/project/current') {
            return Response.json({
              id: 'proj',
              worktree: url.searchParams.get('directory'),
              vcs: 'git',
              time: { created: 1, updated: 1 },
              sandboxes: [],
            });
          }
          if (request.method === 'GET' && url.pathname === `/session/${sessionId}`) {
            if (getsToFail > 0) {
              getsToFail -= 1;
              return Response.json({ error: { message: 'get unavailable' } }, { status: 500 });
            }
            return record
              ? Response.json({
                  ...record,
                  permission: storedPermission,
                  metadata: storedMetadata,
                })
              : Response.json(
                  { name: 'NotFoundError', data: { message: `Session not found: ${sessionId}` } },
                  { status: 404 }
                );
          }
          if (request.method === 'PATCH' && url.pathname === `/session/${sessionId}`) {
            const body = (await request.json()) as EnsureSessionUpdate['body'];
            updates.push({ queryDirectory: url.searchParams.get('directory'), body });
            if (body.permission !== undefined) options.onPermissionUpdate?.();
            if (body.metadata !== undefined && options.metadataUpdateStatus !== undefined) {
              return Response.json(
                { error: { message: `update answered ${options.metadataUpdateStatus}` } },
                { status: options.metadataUpdateStatus }
              );
            }
            if (options.updateStatus !== undefined) {
              return Response.json(
                { error: { message: `update answered ${options.updateStatus}` } },
                { status: options.updateStatus }
              );
            }
            if (updatesToFail > 0) {
              updatesToFail -= 1;
              return Response.json({ error: { message: 'update unavailable' } }, { status: 503 });
            }
            const applied = Array.isArray(body.permission) ? body.permission : [];
            storedPermission = [
              ...(Array.isArray(storedPermission) ? storedPermission : []),
              ...applied,
            ];
            if (body.metadata !== undefined) storedMetadata = body.metadata;
            return Response.json({ ...record, id: sessionId });
          }
          if (request.method === 'POST' && url.pathname === '/kilocode/session-import/session') {
            const body = (await request.json()) as EnsureSessionImport['body'];
            imports.push({ queryDirectory: url.searchParams.get('directory'), body });
            storedPermission = undefined;
            storedMetadata = undefined;
            options.onImport?.();
            return Response.json({ ok: true, id: body.id });
          }
          return new Response(null, { status: 404 });
        },
      });
      startedServers.push(server);
      return { url: server.url.toString(), imports, updates };
    }

    it('returns without importing when the record already belongs to this directory', async () => {
      const sessionId = 'ses_record_same_directory';
      const directory = temporaryDirectory('kilo-api-same-directory-');
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory,
        title: 'keep this title',
        workspaceID: 'wrk_same',
        parentID: 'ses_same_parent',
        share: { url: 'https://share.example/ses_same' },
        summary: { additions: 3, deletions: 1, files: 2 },
        revert: { messageID: 'msg_same_revert' },
        permission: [{ permission: 'bash', pattern: 'git push*', action: 'allow' }],
        time: { created: 1, updated: 2, compacting: 3, archived: 4 },
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.imports).toHaveLength(0);
      expect(stub.updates).toHaveLength(0);
    });

    it('rebinds a record held by another directory with a forced import', async () => {
      const sessionId = 'ses_record_other_directory';
      const directory = temporaryDirectory('kilo-api-rebind-target-');
      const otherDirectory = temporaryDirectory('kilo-api-rebind-other-');
      const created = 1_700_000_000_000;
      // The native record carries the wider shapes too: its summary may hold
      // file diffs and its revert a patch diff. The import stores and serves
      // both, so a re-point passes them through rather than dropping them.
      const summary = {
        additions: 7,
        deletions: 2,
        files: 3,
        diffs: [{ file: 'a.txt', additions: 7, deletions: 2, status: 'modified' }],
      };
      const revert = {
        messageID: 'msg_revert',
        partID: 'prt_revert',
        snapshot: 'snap_revert',
        diff: 'diff --git a/a.txt b/a.txt',
      };
      const permission = [{ permission: 'bash', pattern: 'git push*', action: 'allow' }];
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
        title: 'keep this title',
        workspaceID: 'wrk_carried',
        parentID: 'ses_carried_parent',
        share: { url: 'https://share.example/ses_carried' },
        summary,
        revert,
        permission,
        time: { created, updated: created + 1, compacting: created + 2, archived: created + 3 },
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.imports).toHaveLength(1);
      const parameters = stub.imports[0];
      if (!parameters) throw new Error('Expected a session import');
      expect(parameters.queryDirectory).toBe(directory);
      // The re-point carries every field the record already holds.
      expect(parameters.body).toMatchObject({
        id: sessionId,
        directory,
        force: true,
        title: 'keep this title',
        workspaceID: 'wrk_carried',
        parentID: 'ses_carried_parent',
        shareURL: 'https://share.example/ses_carried',
        summary,
        revert,
        timeCreated: created,
        timeUpdated: created + 1,
        timeCompacting: created + 2,
        timeArchived: created + 3,
      });
    });

    it('carries the record slug when the import re-points it', async () => {
      const sessionId = 'ses_record_with_original_slug';
      const directory = temporaryDirectory('kilo-api-slug-target-');
      const otherDirectory = temporaryDirectory('kilo-api-slug-other-');
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        slug: 'ses_original_slug',
        directory: otherDirectory,
        share: { url: 'https://share.example/ses_original_slug' },
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.imports).toHaveLength(1);
      const parameters = stub.imports[0];
      if (!parameters) throw new Error('Expected a session import');
      expect(parameters.body.slug).toBe('ses_original_slug');
      expect(parameters.body.shareURL).toBe('https://share.example/ses_original_slug');
    });

    it('names the import after the session when the record carries no slug', async () => {
      const sessionId = 'ses_record_without_slug';
      const directory = temporaryDirectory('kilo-api-absent-slug-target-');
      const otherDirectory = temporaryDirectory('kilo-api-absent-slug-other-');
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.imports).toHaveLength(1);
      expect(stub.imports[0]?.body.slug).toBe(sessionId.slice(0, 24));
    });

    it('imports a record whose share is null without a share URL', async () => {
      const sessionId = 'ses_record_null_share';
      const directory = temporaryDirectory('kilo-api-null-share-target-');
      const otherDirectory = temporaryDirectory('kilo-api-null-share-other-');
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
        share: null,
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.imports).toHaveLength(1);
      const parameters = stub.imports[0];
      if (!parameters) throw new Error('Expected a session import');
      expect(parameters.body.force).toBe(true);
      expect(parameters.body).not.toHaveProperty('shareURL');
    });

    it('applies a record ruleset through the update endpoint', async () => {
      const sessionId = 'ses_record_permission';
      const directory = temporaryDirectory('kilo-api-permission-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
        permission,
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.updates).toHaveLength(1);
      expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
    });

    it('retries a ruleset application that fails once, then applies it', async () => {
      const sessionId = 'ses_record_permission_retry';
      const directory = temporaryDirectory('kilo-api-permission-retry-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-retry-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const stub = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, permission },
        { failUpdates: 1 }
      );

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.updates).toHaveLength(2);
      expect(stub.updates[1]).toEqual({ queryDirectory: directory, body: { permission } });
    });

    it('restores the metadata a re-point drops, alongside the ruleset', async () => {
      const sessionId = 'ses_record_metadata';
      const directory = temporaryDirectory('kilo-api-metadata-target-');
      const otherDirectory = temporaryDirectory('kilo-api-metadata-other-');
      const metadata = { 'kilo.goal': { text: 'ship the fix', updatedAt: 5 } };
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
        metadata,
        permission,
      });

      await createClient(stub.url).ensureSession(sessionId, directory);

      // The import cannot carry metadata, so it is restored after the import.
      // It goes before the ruleset so a refused ruleset cannot drop it: the
      // next prepare settles that marker without calling ensureSession again.
      expect(stub.imports).toHaveLength(1);
      expect(stub.updates).toEqual([
        { queryDirectory: directory, body: { metadata } },
        { queryDirectory: directory, body: { permission } },
      ]);
    });

    it('still restores the metadata when the ruleset cannot be applied', async () => {
      const sessionId = 'ses_record_metadata_with_stuck_ruleset';
      const directory = temporaryDirectory('kilo-api-metadata-stuck-target-');
      const otherDirectory = temporaryDirectory('kilo-api-metadata-stuck-other-');
      const metadata = { 'kilo.goal': { text: 'survive a stuck ruleset', updatedAt: 7 } };
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const stub = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, metadata, permission },
        { updateStatus: 503 }
      );

      const outcome = await createClient(stub.url)
        .ensureSession(sessionId, directory)
        .catch(error => error);
      // The ruleset failure is still the route's failure.
      expect(outcome).toBeInstanceOf(Error);
      // The metadata went back before the ruleset attempts, so a later prepare
      // finds it on the record even though the ruleset still fails.
      expect(stub.updates.filter(update => update.body.metadata !== undefined)).toEqual([
        { queryDirectory: directory, body: { metadata } },
      ]);
    });

    it('keeps the route successful when the metadata restore fails', async () => {
      const sessionId = 'ses_record_metadata_failure';
      const directory = temporaryDirectory('kilo-api-metadata-failure-target-');
      const otherDirectory = temporaryDirectory('kilo-api-metadata-failure-other-');
      const metadata = { 'kilo.goal': { text: 'keep the goal', updatedAt: 6 } };
      const stub = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, metadata },
        { metadataUpdateStatus: 500 }
      );

      await createClient(stub.url).ensureSession(sessionId, directory);

      // The import has already committed the record, so a failed restore is
      // skipped instead of failing the route.
      expect(stub.imports).toHaveLength(1);
      expect(stub.imports[0]?.body).toMatchObject({ id: sessionId, directory, force: true });
      expect(stub.updates).toEqual([{ queryDirectory: directory, body: { metadata } }]);
    });

    it('keeps the owed ruleset marker across a fresh process', async () => {
      const sessionId = 'ses_record_permission_durable';
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        // A new process shares only the filesystem, not module memory.
        const script = `
          import { readOutstandingRuleset } from ${JSON.stringify(new URL('./kilo-api.ts', import.meta.url).href)};
          const owed = await readOutstandingRuleset(${JSON.stringify(sessionId)});
          console.log(JSON.stringify(owed ?? null));
        `;
        const proc = Bun.spawn([process.execPath, '--eval', script], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: process.env,
        });
        const output = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(JSON.parse(output.trim())).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
      expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
    });

    it('applies the owed ruleset on the next call instead of reusing an incomplete record', async () => {
      const sessionId = 'ses_record_permission_owed';
      const directory = temporaryDirectory('kilo-api-permission-owed-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-owed-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const failing = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, permission },
        { failUpdates: 5 }
      );
      const first = await createClient(failing.url)
        .ensureSession(sessionId, directory)
        .catch((error: unknown) => error);
      expect(first).toBeInstanceOf(SessionRulesetNotAppliedError);

      // The next call sees the record already at the route directory. Its
      // ruleset was never applied, so it must apply the owed ruleset rather
      // than treat the record as complete.
      const healthy = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory,
      });
      await createClient(healthy.url).ensureSession(sessionId, directory);

      expect(healthy.imports).toHaveLength(0);
      expect(healthy.updates).toHaveLength(1);
      expect(healthy.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
    });

    it('clears the marker without an update when the record already carries the ruleset', async () => {
      const sessionId = 'ses_record_permission_stored';
      const directory = temporaryDirectory('kilo-api-permission-stored-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, {
          id: sessionId,
          directory,
          permission,
        });

        await createClient(stub.url).ensureSession(sessionId, directory);

        expect(stub.imports).toHaveLength(0);
        expect(stub.updates).toHaveLength(0);
        expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('updates a record that lacks the ruleset and clears the marker', async () => {
      const sessionId = 'ses_record_permission_missing';
      const directory = temporaryDirectory('kilo-api-permission-missing-');
      const permission = [{ permission: 'bash', pattern: 'git push*', action: 'allow' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, { id: sessionId, directory });

        await createClient(stub.url).ensureSession(sessionId, directory);

        expect(stub.updates).toHaveLength(1);
        expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
        expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('settles without an update when the record already carries the ruleset', async () => {
      const sessionId = 'ses_record_permission_settle_stored';
      const directory = temporaryDirectory('kilo-api-permission-settle-stored-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, {
          id: sessionId,
          directory,
          permission,
        });

        await createClient(stub.url).settleOutstandingRuleset(sessionId, directory);

        expect(stub.updates).toHaveLength(0);
        expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('settles a record that lacks the ruleset and clears the marker', async () => {
      const sessionId = 'ses_record_permission_settle_missing';
      const directory = temporaryDirectory('kilo-api-permission-settle-missing-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, { id: sessionId, directory });

        await createClient(stub.url).settleOutstandingRuleset(sessionId, directory);

        expect(stub.updates).toHaveLength(1);
        expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
        expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('fails the settle retryably when the permission update cannot be applied', async () => {
      const sessionId = 'ses_record_permission_settle_refused';
      const directory = temporaryDirectory('kilo-api-permission-settle-refused-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(
          sessionId,
          { id: sessionId, directory },
          { updateStatus: 503 }
        );

        const error = await createClient(stub.url)
          .settleOutstandingRuleset(sessionId, directory)
          .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(SessionRulesetUnverifiedError);
        expect(stub.updates).toHaveLength(1);
        // The marker is intact, so a retried step reads it and applies again.
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('keeps the marker when the settle finds no record under the route directory', async () => {
      const sessionId = 'ses_record_permission_settle_absent';
      const directory = temporaryDirectory('kilo-api-permission-settle-absent-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, undefined, { updateStatus: 404 });

        await createClient(stub.url).settleOutstandingRuleset(sessionId, directory);

        // There is nothing to apply to, so the create path keeps the obligation.
        expect(stub.updates).toHaveLength(0);
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('keeps the marker when the record belongs to another directory', async () => {
      const sessionId = 'ses_record_permission_settle_foreign';
      const directory = temporaryDirectory('kilo-api-permission-settle-foreign-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-settle-foreign-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        // The record still names the other directory and carries the rules, but
        // it is not this route's record, so the obligation is not yet met.
        const stub = startEnsureSessionStub(sessionId, {
          id: sessionId,
          directory: otherDirectory,
          permission,
        });

        await createClient(stub.url).settleOutstandingRuleset(sessionId, directory);

        expect(stub.updates).toHaveLength(0);
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('fails the settle when the route record permission is not a ruleset', async () => {
      const sessionId = 'ses_record_permission_settle_invalid';
      const directory = temporaryDirectory('kilo-api-permission-settle-invalid-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        // The record names this directory, so it is this route's session; its
        // permission cannot be compared, so no update may be sent against it.
        const stub = startEnsureSessionStub(sessionId, {
          id: sessionId,
          directory,
          permission: { edit: 'allow' },
        });

        const error = await createClient(stub.url)
          .settleOutstandingRuleset(sessionId, directory)
          .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
        expect(stub.updates).toHaveLength(0);
        // The record is left unchanged, so the obligation is still owed.
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('fails instead of updating a route record whose permission is not a ruleset', async () => {
      const sessionId = 'ses_record_permission_apply_invalid';
      const directory = temporaryDirectory('kilo-api-permission-apply-invalid-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, {
          id: sessionId,
          directory,
          permission: { edit: 'allow' },
        });

        const error = await createClient(stub.url)
          .ensureSession(sessionId, directory)
          .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
        expect(stub.updates).toHaveLength(0);
        expect(stub.imports).toHaveLength(0);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('applies the marker ruleset when the create path finds no record', async () => {
      const sessionId = 'ses_record_permission_marker_create';
      const directory = temporaryDirectory('kilo-api-permission-marker-create-');
      const permission = [{ permission: 'bash', pattern: 'git push*', action: 'allow' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId);

        await createClient(stub.url).ensureSession(sessionId, directory);

        expect(stub.imports).toHaveLength(1);
        expect(stub.updates).toHaveLength(1);
        expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
        expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it.skipIf(process.getuid?.() === 0)(
      'keeps the route successful when the marker cannot be cleared',
      async () => {
        const sessionId = 'ses_record_permission_marker_stuck';
        const directory = temporaryDirectory('kilo-api-permission-stuck-target-');
        const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
        const home = temporaryDirectory('kilo-api-permission-stuck-home-');
        // Outstanding markers live under $HOME, so the test owns their directory.
        const rulesets = join(home, '.kilo-control', 'rulesets');
        const originalHome = process.env.HOME;
        process.env.HOME = home;
        let readOnly = false;
        try {
          await rememberOutstandingRuleset(sessionId, permission);
          const stub = startEnsureSessionStub(sessionId, undefined, {
            onImport: () => {
              chmodSync(rulesets, 0o500);
              readOnly = true;
            },
          });

          // The row is committed before the marker becomes undeletable; the apply
          // itself succeeded, so the surviving marker is not a failure.
          await createClient(stub.url).ensureSession(sessionId, directory);

          expect(stub.imports).toHaveLength(1);
          expect(stub.updates).toHaveLength(1);
          expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
          expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
        } finally {
          if (readOnly) chmodSync(rulesets, 0o700);
          await forgetOutstandingRuleset(sessionId).catch(() => undefined);
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
        }
      }
    );

    it('does not rewrite an existing marker before the import', async () => {
      const sessionId = 'ses_record_permission_marker_kept';
      const directory = temporaryDirectory('kilo-api-permission-durable-target-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      const home = temporaryDirectory('kilo-api-permission-durable-home-');
      const rulesets = join(home, '.kilo-control', 'rulesets');
      const originalHome = process.env.HOME;
      process.env.HOME = home;
      let readOnly = false;
      try {
        await rememberOutstandingRuleset(sessionId, permission);
        chmodSync(rulesets, 0o500);
        readOnly = true;
        const stub = startEnsureSessionStub(sessionId);

        // The obligation is already durable, so a directory that refuses the
        // marker write must not fail the route before the import.
        await createClient(stub.url).ensureSession(sessionId, directory);

        expect(stub.imports).toHaveLength(1);
        expect(stub.updates).toHaveLength(1);
        expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
      } finally {
        if (readOnly) chmodSync(rulesets, 0o700);
        await forgetOutstandingRuleset(sessionId).catch(() => undefined);
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('imports a record that carries the marked ruleset in a directory that refuses writes', async () => {
      const sessionId = 'ses_record_permission_marker_covered';
      const directory = temporaryDirectory('kilo-api-permission-covered-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-covered-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      const home = temporaryDirectory('kilo-api-permission-covered-home-');
      const rulesets = join(home, '.kilo-control', 'rulesets');
      const originalHome = process.env.HOME;
      process.env.HOME = home;
      let readOnly = false;
      try {
        // The marker already holds exactly what the record carries, so the
        // obligation is durable and the write would only repeat it.
        await rememberOutstandingRuleset(sessionId, permission);
        chmodSync(rulesets, 0o500);
        readOnly = true;
        const stub = startEnsureSessionStub(sessionId, {
          id: sessionId,
          directory: otherDirectory,
          permission,
        });

        await createClient(stub.url).ensureSession(sessionId, directory);

        expect(stub.imports).toHaveLength(1);
        expect(stub.updates[0]).toEqual({ queryDirectory: directory, body: { permission } });
      } finally {
        if (readOnly) chmodSync(rulesets, 0o700);
        await forgetOutstandingRuleset(sessionId).catch(() => undefined);
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('keeps the marker readable when the ruleset cannot be applied', async () => {
      const sessionId = 'ses_record_permission_marker_fatal';
      const directory = temporaryDirectory('kilo-api-permission-marker-fatal-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const stub = startEnsureSessionStub(sessionId, undefined, { failUpdates: 5 });

        const error = await createClient(stub.url)
          .ensureSession(sessionId, directory)
          .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
        expect(stub.updates).toHaveLength(3);
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('reports the caller abort instead of a permanent ruleset failure', async () => {
      const sessionId = 'ses_record_permission_apply_aborted';
      const directory = temporaryDirectory('kilo-api-permission-abort-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-abort-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      const controller = new AbortController();
      const stub = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, permission },
        {
          // The caller gives up while its permission update is in flight, which
          // is what a step timeout or a release does.
          onPermissionUpdate: () => controller.abort(new Error('kilo_session aborted')),
        }
      );
      try {
        const error = await createClient(stub.url)
          .ensureSession(sessionId, directory, controller.signal)
          .catch((error: unknown) => error);

        // An interruption is not a ruleset failure: the step keeps its own
        // classification and retry budget, so it must not carry the permanent one.
        expect(error).not.toBeInstanceOf(SessionRulesetError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('kilo_session aborted');
        // The obligation is durable, so the next prepare applies it.
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);
      } finally {
        await forgetOutstandingRuleset(sessionId).catch(() => undefined);
      }
    });

    it('fails the route when a marker is present but is not a ruleset', async () => {
      const sessionId = 'ses_record_permission_marker_not_ruleset';
      const directory = temporaryDirectory('kilo-api-permission-malformed-target-');
      const home = temporaryDirectory('kilo-api-permission-malformed-home-');
      // Outstanding markers live under $HOME, so the test owns their directory.
      const rulesets = join(home, '.kilo-control', 'rulesets');
      const originalHome = process.env.HOME;
      process.env.HOME = home;
      const stub = startEnsureSessionStub(sessionId);
      try {
        mkdirSync(rulesets, { recursive: true });
        // A list whose elements are not rules: the shape a bare array check
        // accepts, and the one that would otherwise be applied as grants.
        writeFileSync(
          join(rulesets, `${encodeURIComponent(sessionId)}.json`),
          '[{"permission":"edit"}]'
        );

        // Present but not a ruleset is still owed: reading it as nothing owed
        // would drop the rules the record never got.
        const readError = await readOutstandingRuleset(sessionId).catch((error: unknown) => error);
        expect(readError).toBeInstanceOf(SessionRulesetNotAppliedError);

        const settleError = await createClient(stub.url)
          .settleOutstandingRuleset(sessionId, directory)
          .catch((error: unknown) => error);
        expect(settleError).toBeInstanceOf(SessionRulesetNotAppliedError);
        expect(stub.updates).toHaveLength(0);
      } finally {
        await forgetOutstandingRuleset(sessionId).catch(() => undefined);
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('fails the route when a marker is not JSON at all', async () => {
      const sessionId = 'ses_record_permission_marker_not_json';
      const home = temporaryDirectory('kilo-api-permission-not-json-home-');
      const rulesets = join(home, '.kilo-control', 'rulesets');
      const originalHome = process.env.HOME;
      process.env.HOME = home;
      try {
        mkdirSync(rulesets, { recursive: true });
        writeFileSync(join(rulesets, `${encodeURIComponent(sessionId)}.json`), 'not json');

        const error = await readOutstandingRuleset(sessionId).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
      } finally {
        await forgetOutstandingRuleset(sessionId).catch(() => undefined);
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it.skipIf(process.getuid?.() === 0)(
      'fails retryably when the marker exists but cannot be read',
      async () => {
        const sessionId = 'ses_record_permission_marker_unreadable';
        const home = temporaryDirectory('kilo-api-permission-unreadable-home-');
        const marker = join(
          home,
          '.kilo-control',
          'rulesets',
          `${encodeURIComponent(sessionId)}.json`
        );
        const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
        const originalHome = process.env.HOME;
        process.env.HOME = home;
        let locked = false;
        try {
          await rememberOutstandingRuleset(sessionId, permission);
          // A file mode of 0000 makes the read itself fail, while the bytes
          // stay in place for the next attempt to read.
          chmodSync(marker, 0o000);
          locked = true;

          const error = await readOutstandingRuleset(sessionId).catch((error: unknown) => error);

          // The marker may be readable on the retry, so the step may run again.
          expect(error).toBeInstanceOf(SessionRulesetUnverifiedError);
          expect((error as SessionRulesetUnverifiedError).retryable).toBe(true);
          expect((error as SessionRulesetUnverifiedError).sessionId).toBe(sessionId);
        } finally {
          if (locked) chmodSync(marker, 0o600);
          await forgetOutstandingRuleset(sessionId).catch(() => undefined);
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
        }
      }
    );

    it.skipIf(process.getuid?.() === 0)(
      'fails retryably when the marker cannot be written before the import',
      async () => {
        const sessionId = 'ses_record_permission_marker_unwritable';
        const home = temporaryDirectory('kilo-api-permission-unwritable-home-');
        const control = join(home, '.kilo-control');
        const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
        const originalHome = process.env.HOME;
        process.env.HOME = home;
        let readOnly = false;
        try {
          mkdirSync(control, { recursive: true });
          chmodSync(control, 0o500);
          readOnly = true;

          const error = await rememberOutstandingRuleset(sessionId, permission).catch(
            (error: unknown) => error
          );

          // The marker goes down before the import, so no record is committed and
          // a retried step can store the marker and import.
          expect(error).toBeInstanceOf(SessionRulesetUnverifiedError);
          expect((error as SessionRulesetUnverifiedError).retryable).toBe(true);
          expect((error as SessionRulesetUnverifiedError).sessionId).toBe(sessionId);
        } finally {
          if (readOnly) chmodSync(control, 0o700);
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
        }
      }
    );

    it('fails the settle retryably and sends no update when the session read cannot answer', async () => {
      const sessionId = 'ses_record_permission_get_unverified';
      const directory = temporaryDirectory('kilo-api-permission-get-unverified-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
      await rememberOutstandingRuleset(sessionId, permission);
      try {
        const failing = startEnsureSessionStub(sessionId, undefined, { getFailures: 1 });

        const error = await createClient(failing.url)
          .settleOutstandingRuleset(sessionId, directory)
          .catch((error: unknown) => error);

        // A read that cannot answer must not report "the record lacks these
        // rules": the update appends, so a second copy would stay.
        expect(error).toBeInstanceOf(SessionRulesetUnverifiedError);
        expect((error as SessionRulesetUnverifiedError).retryable).toBe(true);
        expect(failing.updates).toHaveLength(0);
        expect(await readOutstandingRuleset(sessionId)).toEqual(permission);

        // The retry reads the record again and applies the rules exactly once.
        const healthy = startEnsureSessionStub(sessionId, { id: sessionId, directory });
        await createClient(healthy.url).settleOutstandingRuleset(sessionId, directory);

        expect(healthy.updates).toEqual([{ queryDirectory: directory, body: { permission } }]);
        expect(await readOutstandingRuleset(sessionId)).toBeUndefined();
      } finally {
        await forgetOutstandingRuleset(sessionId);
      }
    });

    it('fails instead of importing when the record permission is not a ruleset', async () => {
      const sessionId = 'ses_record_permission_not_ruleset';
      const directory = temporaryDirectory('kilo-api-record-not-ruleset-');
      const otherDirectory = temporaryDirectory('kilo-api-record-not-ruleset-other-');
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
        permission: [{ nope: true }],
      });

      const error = await createClient(stub.url)
        .ensureSession(sessionId, directory)
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
      expect(stub.imports).toHaveLength(0);
      expect(stub.updates).toHaveLength(0);
    });

    it('reports a ruleset application that keeps failing', async () => {
      const sessionId = 'ses_record_permission_failing';
      const directory = temporaryDirectory('kilo-api-permission-fail-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-fail-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const stub = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, permission },
        { failUpdates: 5 }
      );

      const error = await createClient(stub.url)
        .ensureSession(sessionId, directory)
        .catch((error: unknown) => error);
      await forgetOutstandingRuleset(sessionId);

      expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
      expect((error as Error).message).toContain('Session ruleset not applied');
      expect(stub.updates).toHaveLength(3);
    });

    it('marks a failed ruleset application as not worth retrying', async () => {
      const sessionId = 'ses_record_permission_final';
      const directory = temporaryDirectory('kilo-api-permission-final-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-final-other-');
      const permission = [{ permission: 'edit', pattern: '*', action: 'deny' }];
      const stub = startEnsureSessionStub(
        sessionId,
        { id: sessionId, directory: otherDirectory, permission },
        { failUpdates: 5 }
      );

      const error = await createClient(stub.url)
        .ensureSession(sessionId, directory)
        .catch((error: unknown) => error);
      await forgetOutstandingRuleset(sessionId);

      expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
      expect((error as SessionRulesetNotAppliedError).retryable).toBe(false);
      expect((error as SessionRulesetNotAppliedError).sessionId).toBe(sessionId);
    });

    it('fails instead of applying a record permission that is not a ruleset', async () => {
      const sessionId = 'ses_record_permission_map';
      const directory = temporaryDirectory('kilo-api-permission-map-target-');
      const otherDirectory = temporaryDirectory('kilo-api-permission-map-other-');
      const stub = startEnsureSessionStub(sessionId, {
        id: sessionId,
        directory: otherDirectory,
        permission: { bash: 'deny' },
      });

      const error = await createClient(stub.url)
        .ensureSession(sessionId, directory)
        .catch((error: unknown) => error);

      // The record carries permission data that cannot be applied as rules, so
      // the route fails instead of importing without them.
      expect(error).toBeInstanceOf(SessionRulesetNotAppliedError);
      expect(stub.imports).toHaveLength(0);
      expect(stub.updates).toHaveLength(0);
    });

    it('imports an absent record without a force flag', async () => {
      const sessionId = 'ses_record_absent';
      const directory = temporaryDirectory('kilo-api-absent-directory-');
      const stub = startEnsureSessionStub(sessionId);

      await createClient(stub.url).ensureSession(sessionId, directory);

      expect(stub.imports).toHaveLength(1);
      const parameters = stub.imports[0];
      if (!parameters) throw new Error('Expected a session import');
      expect('force' in parameters.body).toBe(false);
      expect(parameters.body.id).toBe(sessionId);
      expect(parameters.queryDirectory).toBe(directory);
      expect(parameters.body.directory).toBe(directory);
    });

    it('treats a symlinked route directory as the record directory', async () => {
      const sessionId = 'ses_record_symlink_directory';
      const realDirectory = temporaryDirectory('kilo-api-real-directory-');
      const linkPath = join(temporaryDirectory('kilo-api-link-parent-'), 'route');
      symlinkSync(realDirectory, linkPath);
      const stub = startEnsureSessionStub(sessionId, { id: sessionId, directory: realDirectory });

      await createClient(stub.url).ensureSession(sessionId, linkPath);

      expect(stub.imports).toHaveLength(0);
    });

    it('imports when the record carries no directory to match', async () => {
      const sessionId = 'ses_record_without_directory';
      const directory = temporaryDirectory('kilo-api-missing-directory-');
      const imports: EnsureSessionImport[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/project/current') {
            return Response.json({ id: 'proj', worktree: url.searchParams.get('directory') });
          }
          if (request.method === 'GET' && url.pathname === `/session/${sessionId}`) {
            return Response.json({ id: sessionId, title: 'no directory field' });
          }
          if (request.method === 'POST' && url.pathname === '/kilocode/session-import/session') {
            imports.push({
              queryDirectory: url.searchParams.get('directory'),
              body: await request.json(),
            });
            return Response.json({ ok: true, id: sessionId });
          }
          return new Response(null, { status: 404 });
        },
      });
      startedServers.push(server);

      await createClient(server.url.toString()).ensureSession(sessionId, directory);

      expect(imports).toHaveLength(1);
      expect(imports[0]?.body).toMatchObject({ id: sessionId, directory, force: true });
    });
  });

  it.each(
    [null, [], '', { ses_1: null }, { ses_1: {} }, { ses_1: { type: 1 } }].map(body => ({ body }))
  )('rejects malformed successful session status maps: %j', async ({ body }) => {
    const result: unknown = await createClient(startStub(200, body).url)
      .getSessionStatuses()
      .catch(error => error);
    expect(result).toBeInstanceOf(Error);
  });

  it.each([
    { status: 204, body: undefined },
    { status: 500, body: {} },
  ])('rejects unavailable session status: %j', async ({ status, body }) => {
    const result: unknown = await createClient(startStub(status, body).url)
      .getSessionStatuses()
      .catch(error => error);
    expect(result).toBeInstanceOf(Error);
  });

  it('validates exact session existence for cleanup without importing', async () => {
    const directory = '/workspace/exact';
    const client = createClient(startStub(200, { id: 'ses_1', directory }).url);
    expect(await client.getSessionDetails('ses_1', directory)).toEqual({ id: 'ses_1', directory });
    for (const lookup of [
      () => client.getSessionDetails('ses_other', directory),
      () => client.getSessionDetails('ses_1', '/other'),
      () => createClient(startStub(404, {}).url).getSessionDetails('ses_1', directory),
    ]) {
      const result: unknown = await lookup().catch(error => error);
      expect(result).toBeInstanceOf(Error);
    }
  });

  it('sends server context as a synthetic part before the prompt', async () => {
    const stub = startStub(200, true);
    await createClient(stub.url).sendPromptAsync({
      sessionId: 'ses_1',
      messageId: 'msg_1',
      prompt: 'hello',
      context: '<cloud-agent-context session-id="workspace_1" />',
    });
    expect(stub.requests[0]?.body).toMatchObject({
      parts: [
        {
          type: 'text',
          text: '<cloud-agent-context session-id="workspace_1" />',
          synthetic: true,
        },
        { type: 'text', text: 'hello' },
      ],
    });
  });

  it('probes one tool part and returns only metadata', async () => {
    const stub = startStub(200, {
      info: { id: 'assistant_1', role: 'assistant' },
      parts: [
        {
          id: 'part_1',
          type: 'tool',
          sessionID: 'ses_1',
          messageID: 'assistant_1',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'secret' }, output: 'é', title: 'run' },
        },
      ],
    });
    const result = await createClient(stub.url).probeMessagePart?.(
      'ses_1',
      '/workspace/exact',
      'assistant_1',
      'part_1',
      new AbortController().signal
    );
    expect(result).toEqual({ status: 'completed', outputBytes: 2 });
    expect(stub.requests[0]).toMatchObject({
      method: 'GET',
      pathname: '/session/ses_1/message/assistant_1',
      directory: '/workspace/exact',
    });
  });

  it('accepts genuinely empty successful session status and pending-input results', async () => {
    expect(await createClient(startStub(200, {}).url).getSessionStatuses()).toEqual({});
    expect(await createClient(startStub(200, []).url).getQuestions()).toEqual([]);
    expect(await createClient(startStub(200, []).url).getPermissions()).toEqual([]);
    expect(await createClient(startStub(200, []).url).getSessionDiff('ses_1')).toEqual([]);
  });

  it('cancels a native diff HTTP read without treating it as an empty result', async () => {
    const stub = startStub(200, []);
    const controller = new AbortController();
    controller.abort(new Error('Diff request cancelled'));
    const error: unknown = await createClient(stub.url)
      .getSessionDiff('ses_1', '/attached', controller.signal)
      .catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: 'Session diff ses_1 failed: request error' });
    expect(stub.requests).toHaveLength(0);
  });

  it('scopes question lists, answers, and rejections to the owning checkout directory', async () => {
    const directory = '/workspace/shared checkout & tools';
    const pending = new Map(questions.map(question => [question.id, question]));
    const requests: Array<{ pathname: string; directory: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({ pathname: url.pathname, directory: url.searchParams.get('directory') });
        if (url.searchParams.get('directory') !== directory) {
          return Response.json({ message: 'Wrong checkout' }, { status: 404 });
        }
        if (url.pathname === '/question') return Response.json([...pending.values()]);
        if (url.pathname === '/question/question_1/reply') {
          expect(await request.json()).toEqual({ answers: [['All']] });
          pending.delete('question_1');
          return Response.json(true);
        }
        if (url.pathname === '/question/question_1/reject') {
          pending.delete('question_1');
          return Response.json(true);
        }
        return new Response(null, { status: 404 });
      },
    });
    startedServers.push(server);
    const client = createClient(server.url.toString());

    expect(await client.getQuestions(directory)).toEqual(questions);
    expect(await client.answerQuestion('question_1', [['All']], directory)).toBe(true);
    expect(await client.getQuestions(directory)).toEqual([]);
    pending.set(questions[0].id, questions[0]);
    expect(await client.rejectQuestion('question_1', directory)).toBe(true);
    expect(await client.getQuestions(directory)).toEqual([]);
    expect(requests).toEqual([
      { pathname: '/question', directory },
      { pathname: '/question/question_1/reply', directory },
      { pathname: '/question', directory },
      { pathname: '/question/question_1/reject', directory },
      { pathname: '/question', directory },
    ]);
  });

  it.each(['prompt', 'command'] as const)(
    'preserves the durable message ID and terminal assistant response for a synchronous %s',
    async operation => {
      const completion: Awaited<ReturnType<WrapperKiloClient['sendPrompt']>> = {
        info: {
          id: 'assistant_1',
          sessionID: 'ses_1',
          parentID: 'message_durable',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          modelID: 'example',
          providerID: 'kilo',
          mode: 'code',
          agent: 'code',
          path: { cwd: '/checkout', root: '/checkout' },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          error: { name: 'MessageAbortedError', data: { message: 'Cancelled' } },
        },
        parts: [],
      };
      const stub = startStub(200, completion);
      const client = createClient(stub.url);
      const options = { sessionId: 'ses_1', messageId: 'message_durable', directory: '/checkout' };
      const result =
        operation === 'prompt'
          ? await client.sendPrompt({ ...options, prompt: 'hello' })
          : await client.sendCommand({ ...options, command: 'review' });

      expect(result).toEqual(completion);
      expect(stub.requests).toEqual([
        {
          method: 'POST',
          pathname: operation === 'prompt' ? '/session/ses_1/message' : '/session/ses_1/command',
          directory: '/checkout',
          body:
            operation === 'prompt'
              ? { messageID: 'message_durable', parts: [{ type: 'text', text: 'hello' }] }
              : { messageID: 'message_durable', command: 'review', arguments: '' },
        },
      ]);
    }
  );

  it('retains complete typed pending question contents', async () => {
    const stub = startStub(200, questions);
    const result = await createClient(stub.url).getQuestions();
    expect(result[0]?.questions[0]?.options[0]?.description).toBe('Apply every change');
    expect(result).toEqual(questions);
  });

  it('POSTs an interactive reply to /permission/<id>/reply on a trailing-slash URL', async () => {
    const stub = startStub(200);
    const client = createClient(stub.url);

    const result = await client.answerPermission('perm_1', 'once', undefined, true);
    expect(result).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_1/reply');
    expect(stub.requests[0].directory).toBe('/workspace');
    expect(stub.requests[0].body).toEqual({ reply: 'once', interactive: true });
  });

  it('omits interactive and message for the non-interactive auto-approve shape', async () => {
    const stub = startStub(200);
    const client = createClient(stub.url);

    const result = await client.answerPermission('perm_2', 'always');
    expect(result).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_2/reply');
    expect(stub.requests[0].body).toEqual({ reply: 'always' });
  });

  it('serializes an explicitly non-interactive permission reply', async () => {
    const stub = startStub(200);
    const client = createClient(stub.url);

    await client.answerPermission('perm_2', 'always', undefined, false, '/workspace/attached');
    expect(stub.requests[0]?.body).toEqual({ reply: 'always', interactive: false });
    expect(stub.requests[0]?.directory).toBe('/workspace/attached');
  });

  it('threads the message through an interactive reply on a stripped URL', async () => {
    const stub = startStub(200);
    const client = createClient(stub.url.replace(/\/+$/, ''));

    const result = await client.answerPermission('perm_3', 'reject', 'continue read-only', true);
    expect(result).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_3/reply');
    expect(stub.requests[0].body).toEqual({
      reply: 'reject',
      message: 'continue read-only',
      interactive: true,
    });
  });

  it('throws on a non-2xx reply', async () => {
    const stub = startStub(500);
    const client = createClient(stub.url.replace(/\/+$/, ''));

    let caught: Error | undefined;
    try {
      await client.answerPermission('perm_4', 'once', undefined, true);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/Permission reply perm_4 failed/);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_4/reply');
  });

  it('returns true and serializes the default and attached drain directory', async () => {
    for (const directory of [undefined, '/workspace/attached repo & tests']) {
      const stub = startStub(200, true);
      const client = createClient(stub.url);

      expect(
        await client.drainSession({ sessionId: 'ses_1', directory, token: 'drain-token' })
      ).toBe(true);
      expect(stub.requests).toEqual([
        {
          method: 'POST',
          pathname: '/kilocode/session/ses_1/drain',
          directory: directory ?? '/workspace',
          body: { token: 'drain-token' },
        },
      ]);
    }
  });

  it('classifies a 404 without leaking the response body', async () => {
    const stub = startStub(404, { message: 'secret-drain-token' });
    const error = await createClient(stub.url)
      .drainSession({ sessionId: 'ses_1', token: 'drain-token' })
      .catch(cause => cause);

    expect(error).toBeInstanceOf(DrainSessionError);
    const drainError = error as DrainSessionError;
    expect(drainError.kind).toBe('definitive');
    expect(drainError.status).toBe(404);
    expect(drainError.message).toBe('HTTP 404');
    expect(drainError.message).not.toContain('secret-drain-token');
  });

  it.each([408, 429, 503])('classifies HTTP %i as transient', async status => {
    const stub = startStub(status, { message: 'transient-body' });
    const error = await createClient(stub.url)
      .drainSession({ sessionId: 'ses_1', token: 'drain-token' })
      .catch(cause => cause);

    expect(error).toBeInstanceOf(DrainSessionError);
    const drainError = error as DrainSessionError;
    expect(drainError.kind).toBe('transient');
    expect(drainError.status).toBe(status);
    expect(drainError.message).toBe(`HTTP ${status}`);
  });

  it('classifies a refused connection as a transient request error', async () => {
    const error = await createClient('http://127.0.0.1:1/')
      .drainSession({ sessionId: 'ses_1', token: 'drain-token' })
      .catch(cause => cause);

    expect(error).toBeInstanceOf(DrainSessionError);
    const drainError = error as DrainSessionError;
    expect(drainError.kind).toBe('transient');
    expect(drainError.message).toBe('request error');
  });

  it('treats a boolean false as an anomalous failure with the exact message', async () => {
    const stub = startStub(200, false);
    const error = await createClient(stub.url)
      .drainSession({ sessionId: 'ses_1', token: 'drain-token' })
      .catch(cause => cause);

    expect(error).toBeInstanceOf(DrainSessionError);
    const drainError = error as DrainSessionError;
    expect(drainError.kind).toBe('anomalous');
    expect(drainError.message).toBe('Session drain returned false');
  });

  it('treats 204 and a 200 non-boolean as anomalous with no boolean result', async () => {
    for (const stub of [startStub(204), startStub(200, { ok: true })]) {
      const error = await createClient(stub.url)
        .drainSession({ sessionId: 'ses_1', token: 'drain-token' })
        .catch(cause => cause);

      expect(error).toBeInstanceOf(DrainSessionError);
      const drainError = error as DrainSessionError;
      expect(drainError.kind).toBe('anomalous');
      expect(drainError.message).toBe('returned no boolean result');
    }
  });

  it('rejects an already-aborted caller signal without a DrainSessionError', async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = startStub(200, true);

    const error = await createClient(stub.url)
      .drainSession({ sessionId: 'ses_1', token: 'drain-token', signal: controller.signal })
      .catch(cause => cause);

    expect(error).not.toBeInstanceOf(DrainSessionError);
  });
});
