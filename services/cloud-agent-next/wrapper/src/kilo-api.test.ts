import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createServer, type IncomingMessage } from 'node:http';
import { createKiloClient } from '@kilocode/sdk';
import type { QuestionRequest } from '@kilocode/sdk/v2';
import {
  createWrapperKiloClient,
  isKiloServerUnreachableError,
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
      serverUrl,
      '/workspace'
    );
  }

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

  it.each([
    { name: 'empty object', body: {} },
    { name: 'success-shaped object', body: { success: true } },
    { name: 'string', body: 'true' },
    { name: 'number', body: 1 },
    { name: 'array', body: [] },
  ])('rejects a non-boolean abort acknowledgement: %j', async ({ body }) => {
    const stub = startStub(200, body);
    const error: unknown = await createClient(stub.url)
      .abortSession({ sessionId: 'ses_1' })
      .catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected invalid abort response failure');
    expect(error.message).toBe('Session abort for ses_1 returned no boolean result');
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
      const client = createWrapperKiloClient(createKiloClient({ baseUrl: url }), url, directory);
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
});
