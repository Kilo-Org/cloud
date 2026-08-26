import { describe, expect, it, vi } from 'vitest';
import {
  VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG,
  VERCEL_CLOUD_AGENT_RESOURCE_TAG,
  VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
  VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG,
  VercelSandboxRestClient,
  type VercelSandboxCommand,
  type VercelSandboxResource,
  type VercelSandboxSession,
} from './vercel-sandbox-rest-client.js';

const sandboxName = 'ses-exact-runtime';
const sessionId = 'sbox_session_exact';
const commandId = 'cmd_exact';

function sandbox(overrides: Partial<VercelSandboxResource> = {}): VercelSandboxResource {
  return {
    name: sandboxName,
    currentSessionId: sessionId,
    status: 'running',
    persistent: false,
    createdAt: 1,
    updatedAt: 2,
    tags: {
      [VERCEL_CLOUD_AGENT_RESOURCE_TAG]: VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
      [VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG]: 'operation-123',
      [VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG]: 'runtime-build-123',
    },
    ...overrides,
  };
}

function session(overrides: Partial<VercelSandboxSession> = {}): VercelSandboxSession {
  return {
    id: sessionId,
    sourceSandboxName: sandboxName,
    projectId: 'prj_test',
    sourceSnapshotId: 'snap_base',
    runtime: 'node24',
    status: 'running',
    memory: 4096,
    vcpus: 2,
    region: 'iad1',
    timeout: 300_000,
    requestedAt: 1,
    cwd: '/vercel/sandbox',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function command(overrides: Partial<VercelSandboxCommand> = {}): VercelSandboxCommand {
  return {
    id: commandId,
    name: 'bash',
    args: ['-lc', 'echo ready'],
    cwd: '/vercel/sandbox',
    sessionId,
    exitCode: null,
    startedAt: 3,
    ...overrides,
  };
}

function clientFor(providerFetch: typeof fetch) {
  return new VercelSandboxRestClient({
    accessToken: 'secret-access-token',
    projectId: 'prj_test',
    teamId: 'team_test',
    fetch: providerFetch,
  });
}

function createInput() {
  return {
    name: sandboxName,
    operationId: 'operation-123',
    runtimeBuildId: 'runtime-build-123',
    snapshotId: 'snap_base',
    runtime: 'node24' as const,
    timeoutMs: 300_000,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

describe('VercelSandboxRestClient', () => {
  it('creates a non-persistent sandbox and returns its fully correlated runtime locator', async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        sandbox: sandbox(),
        session: session(),
        routes: [{ url: 'https://route.example', subdomain: 'route', port: 3000 }],
      })
    );

    const result = await clientFor(providerFetch).createSandbox(createInput());

    expect(result.runtime).toEqual({ sandboxName, sessionId });
    expect(result.routes).toHaveLength(1);
    const [url, init] = providerFetch.mock.calls[0];
    expect(url).toBe('https://api.vercel.com/v2/sandboxes?teamId=team_test');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'prj_test',
      name: sandboxName,
      source: { type: 'snapshot', snapshotId: 'snap_base' },
      runtime: 'node24',
      timeout: 300_000,
      persistent: false,
      tags: {
        [VERCEL_CLOUD_AGENT_RESOURCE_TAG]: VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
        [VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG]: 'operation-123',
        [VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG]: 'runtime-build-123',
      },
    });
  });

  it('invokes the injected fetch as a free function', async () => {
    function providerFetch(this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError('Illegal invocation'));
      }
      return Promise.resolve(jsonResponse({ sandbox: sandbox(), session: session(), routes: [] }));
    }

    await expect(clientFor(providerFetch).createSandbox(createInput())).resolves.toMatchObject({
      runtime: { sandboxName, sessionId },
    });
  });

  it.each([
    ['sandbox name', { sandbox: sandbox({ name: 'ses-other' }), session: session(), routes: [] }],
    [
      'current session',
      { sandbox: sandbox({ currentSessionId: 'sbox_other' }), session: session(), routes: [] },
    ],
    ['project', { sandbox: sandbox(), session: session({ projectId: 'prj_other' }), routes: [] }],
    [
      'snapshot',
      { sandbox: sandbox(), session: session({ sourceSnapshotId: 'snap_other' }), routes: [] },
    ],
    ['runtime', { sandbox: sandbox(), session: session({ runtime: 'node22' }), routes: [] }],
    [
      'operation tag',
      {
        sandbox: sandbox({
          tags: {
            [VERCEL_CLOUD_AGENT_RESOURCE_TAG]: VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
            [VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG]: 'operation-other',
            [VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG]: 'runtime-build-123',
          },
        }),
        session: session(),
        routes: [],
      },
    ],
    ['persistence', { sandbox: sandbox({ persistent: true }), session: session(), routes: [] }],
  ])('rejects a create envelope with mismatched %s', async (_field, body) => {
    const client = clientFor(vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(client.createSandbox(createInput())).rejects.toThrow(
      'Vercel Sandbox create failed (correlation_mismatch)'
    );
  });

  it('inspects by name without resuming and returns a correlated create envelope', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ resumed: false, sandbox: sandbox(), session: session(), routes: [] })
      );

    const result = await clientFor(providerFetch).inspectByName(createInput());

    expect(result?.runtime).toEqual({ sandboxName, sessionId });
    expect(providerFetch.mock.calls[0][0]).toBe(
      'https://api.vercel.com/v2/sandboxes/ses-exact-runtime?projectId=prj_test&teamId=team_test&resume=false'
    );
  });

  it('returns null for absent non-resuming create reconciliation', async () => {
    const client = clientFor(vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(client.inspectByName(createInput())).resolves.toBeNull();
  });

  it('gets and correlates an exact session', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ session: session(), routes: [] }));
    const result = await clientFor(providerFetch).getSession(sessionId, sandboxName);
    expect(result.session.id).toBe(sessionId);
    expect(providerFetch.mock.calls[0][0]).toBe(
      'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact?teamId=team_test'
    );
  });

  it('executes a detached command and correlates its session', async () => {
    const providerFetch = vi.fn().mockResolvedValue(jsonResponse({ command: command() }));
    const result = await clientFor(providerFetch).executeCommand(sessionId, {
      command: 'bash',
      args: ['-lc', 'echo ready'],
      cwd: '/vercel/sandbox',
      env: { SAFE_VALUE: 'yes' },
      sudo: false,
      timeoutMs: 10_000,
      wait: false,
    });
    expect(result.id).toBe(commandId);
    expect(JSON.parse(providerFetch.mock.calls[0][1].body as string)).toEqual({
      command: 'bash',
      args: ['-lc', 'echo ready'],
      cwd: '/vercel/sandbox',
      env: { SAFE_VALUE: 'yes' },
      sudo: false,
      timeout: 10_000,
    });
  });

  it('parses a bounded wait:true NDJSON command response', async () => {
    const body = `${JSON.stringify({ command: command() })}\n${JSON.stringify({ command: command({ exitCode: 0 }) })}\n`;
    const providerFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
      );
    const result = await clientFor(providerFetch).executeCommand(sessionId, {
      command: 'bash',
      args: [],
      env: {},
      sudo: false,
      wait: true,
    });
    expect(result).toEqual({ command: command(), finished: command({ exitCode: 0 }) });
  });

  it('rejects oversized JSON and NDJSON responses without including their contents', async () => {
    const secret = 'provider-secret-response';
    const oversizedJson = jsonResponse({ session: session(), padding: secret.repeat(70_000) });
    const jsonClient = clientFor(vi.fn().mockResolvedValue(oversizedJson));
    await expect(jsonClient.getSession(sessionId, sandboxName)).rejects.toMatchObject({
      kind: 'response_too_large',
      message: 'Vercel Sandbox get-session failed (response_too_large)',
    });

    const oversizedNdjson = new Response(secret.repeat(1_100_000), {
      headers: { 'content-type': 'application/x-ndjson' },
    });
    const streamClient = clientFor(vi.fn().mockResolvedValue(oversizedNdjson));
    await expect(
      streamClient.executeCommand(sessionId, {
        command: 'bash',
        args: [],
        env: {},
        sudo: false,
        wait: true,
      })
    ).rejects.not.toThrow(secret);
  });

  it('writes a gzip tar archive and reads exact-session files within caller bounds', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        new Response('response-body', {
          headers: { 'content-type': 'application/octet-stream' },
        })
      );
    const client = clientFor(providerFetch);

    await client.writeFiles(sessionId, '/tmp', [
      { path: 'private/request.json', content: '{"token":"secret"}' },
    ]);
    await expect(client.readFile(sessionId, '/tmp/private/response.json', 32)).resolves.toEqual(
      new TextEncoder().encode('response-body')
    );

    const [writeUrl, writeInit] = providerFetch.mock.calls[0];
    expect(writeUrl).toBe(
      'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/fs/write?teamId=team_test'
    );
    expect(new Headers(writeInit.headers).get('content-type')).toBe('application/gzip');
    expect(new Headers(writeInit.headers).get('x-cwd')).toBe('/tmp');
    expect(writeInit.body).toBeInstanceOf(Uint8Array);
    expect(providerFetch.mock.calls[1][0]).toBe(
      'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/fs/read?teamId=team_test'
    );
    expect(JSON.parse(providerFetch.mock.calls[1][1].body as string)).toEqual({
      path: '/tmp/private/response.json',
    });
  });

  it('rejects file responses that exceed the requested read bound', async () => {
    const client = clientFor(
      vi.fn().mockResolvedValue(
        new Response('too-large', {
          headers: { 'content-length': '9', 'content-type': 'application/octet-stream' },
        })
      )
    );

    await expect(client.readFile(sessionId, '/tmp/response', 4)).rejects.toMatchObject({
      kind: 'response_too_large',
      operation: 'read-file',
    });
  });

  it('lists, gets, and kills only commands correlated to the exact session', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ commands: [command()] }))
      .mockResolvedValueOnce(jsonResponse({ command: command() }))
      .mockResolvedValueOnce(jsonResponse({ command: command({ exitCode: 143 }) }));
    const client = clientFor(providerFetch);

    await expect(client.listCommands(sessionId)).resolves.toEqual([command()]);
    await expect(client.getCommand(sessionId, commandId)).resolves.toEqual(command());
    await expect(client.killCommand(sessionId, commandId, 15)).resolves.toEqual(
      command({ exitCode: 143 })
    );
    expect(providerFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/cmd?teamId=team_test',
      'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/cmd/cmd_exact?teamId=team_test',
      'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/cmd/cmd_exact/kill?teamId=team_test',
    ]);
  });

  it.each([
    ['list-commands', { commands: [command({ sessionId: 'sbox_other' })] }],
    ['get-command', { command: command({ id: 'cmd_other' }) }],
    ['kill-command', { command: command({ sessionId: 'sbox_other' }) }],
  ])('rejects mismatched %s responses', async (operation, body) => {
    const client = clientFor(vi.fn().mockResolvedValue(jsonResponse(body)));
    const call =
      operation === 'list-commands'
        ? client.listCommands(sessionId)
        : operation === 'get-command'
          ? client.getCommand(sessionId, commandId)
          : client.killCommand(sessionId, commandId, 9);
    await expect(call).rejects.toThrow(`Vercel Sandbox ${operation} failed (correlation_mismatch)`);
  });

  it('extends and stops the exact correlated session without a named DELETE API', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ session: session({ timeout: 360_000 }) }))
      .mockResolvedValueOnce(jsonResponse({ session: session({ status: 'stopped' }) }));
    const client = clientFor(providerFetch);

    await expect(
      client.extendSessionTimeout(sessionId, sandboxName, 60_000)
    ).resolves.toMatchObject({
      timeout: 360_000,
    });
    await expect(client.stopSession(sessionId, sandboxName)).resolves.toMatchObject({
      status: 'stopped',
    });
    expect(providerFetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [
        'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/extend-timeout?teamId=team_test',
        'POST',
      ],
      [
        'https://api.vercel.com/v2/sandboxes/sessions/sbox_session_exact/stop?teamId=team_test',
        'POST',
      ],
    ]);
    const stopInit = providerFetch.mock.calls[1]?.[1] as RequestInit;
    expect(stopInit.body).toBe('{}');
    expect(new Headers(stopInit.headers).get('Content-Type')).toBe('application/json');
    expect('deleteSandbox' in client).toBe(false);
  });

  it('aborts stalled observation requests with a secret-safe typed error', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let providerSignal: AbortSignal | null | undefined;
    const providerFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      providerSignal = init?.signal;
      if (!providerSignal) return Promise.reject(new Error('missing provider deadline'));
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), {
          once: true,
        });
      });
    });
    const request = clientFor(providerFetch).getSession(sessionId, sandboxName);

    controller.abort(new Error('provider-secret-timeout'));
    const error = await request.catch(cause => cause);

    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(providerSignal?.aborted).toBe(true);
    expect(error).toMatchObject({
      kind: 'request_failed',
      operation: 'get-session',
      message: 'Vercel Sandbox get-session failed (request_failed)',
    });
    expect(String(error)).not.toContain('provider-secret-timeout');
    timeout.mockRestore();
  });

  it('classifies a deadline while reading a provider body as request failure', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const providerFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(streamController) {
              signal?.addEventListener('abort', () => streamController.error(signal.reason), {
                once: true,
              });
            },
          })
        )
      );
    });
    const request = clientFor(providerFetch).readFile(sessionId, '/tmp/response', 32);

    controller.abort(new Error('provider-secret-timeout'));
    const error = await request.catch(cause => cause);

    expect(error).toMatchObject({ kind: 'request_failed', operation: 'read-file' });
    expect(String(error)).not.toContain('provider-secret-timeout');
    timeout.mockRestore();
  });

  it('bounds waited command deadlines with transport allowance and a maximum', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const providerFetch = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const client = clientFor(providerFetch);

    await expect(
      client.executeCommand(sessionId, {
        command: 'bash',
        args: [],
        env: {},
        sudo: false,
        timeoutMs: 30_000,
        wait: true,
      })
    ).rejects.toMatchObject({ kind: 'request_failed', operation: 'execute-command' });
    await expect(
      client.executeCommand(sessionId, {
        command: 'bash',
        args: [],
        env: {},
        sudo: false,
        timeoutMs: 600_000,
        wait: true,
      })
    ).rejects.toMatchObject({ kind: 'request_failed', operation: 'execute-command' });
    await expect(
      client.executeCommand(sessionId, {
        command: 'bash',
        args: [],
        env: {},
        sudo: false,
        wait: false,
      })
    ).rejects.toMatchObject({ kind: 'request_failed', operation: 'execute-command' });

    expect(timeout.mock.calls).toEqual([[40_000], [300_000], [120_000]]);
    timeout.mockRestore();
  });

  it('uses secret-safe typed errors for transport, provider, and invalid response failures', async () => {
    const reflectedSecret = 'secret-access-token reflected-provider-body';
    const providerClient = clientFor(
      vi.fn().mockResolvedValue(new Response(reflectedSecret, { status: 403 }))
    );
    await expect(providerClient.getSession(sessionId, sandboxName)).rejects.toMatchObject({
      kind: 'request_failed',
      operation: 'get-session',
      status: 403,
      message: 'Vercel Sandbox get-session failed (request_failed, status 403)',
    });
    await expect(providerClient.getSession(sessionId, sandboxName)).rejects.not.toThrow(
      reflectedSecret
    );

    const invalidClient = clientFor(
      vi.fn().mockResolvedValue(jsonResponse({ token: reflectedSecret }))
    );
    await expect(invalidClient.getSession(sessionId, sandboxName)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    await expect(invalidClient.getSession(sessionId, sandboxName)).rejects.not.toThrow(
      reflectedSecret
    );
  });
});
