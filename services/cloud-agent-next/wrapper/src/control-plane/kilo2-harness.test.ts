import { afterEach, describe, expect, it } from 'bun:test';
import { createKilo2Harness } from './kilo2-harness.js';
import { createKilo2Lifecycle } from './kilo2-lifecycle.js';

type RecordedRequest = {
  method: string;
  pathname: string;
  directory: string | null;
  authorization: string | null;
  body: unknown;
};

const directory = '/workspace/harness';

const startedServers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map(server => server.stop(true)));
});

function startStub(handle: (request: Request, url: URL, requests: RecordedRequest[]) => Response) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        pathname: url.pathname,
        directory: url.searchParams.get('location[directory]'),
        authorization: request.headers.get('authorization'),
        body: request.body ? await request.json() : undefined,
      });
      return handle(request, url, requests);
    },
  });
  startedServers.push(server);
  return { url: server.url.toString(), requests };
}

function createHarness(serverUrl: string) {
  return createKilo2Harness({
    server: { url: serverUrl, authorization: 'Basic harness-test' },
    directory,
    lifecycle: createKilo2Lifecycle(),
  });
}

function statusResponse(status: string, error?: string) {
  return Response.json([
    { name: 'kilo-cloud-agent', status: { status, ...(error === undefined ? {} : { error }) } },
  ]);
}

const credential = {
  url: 'https://mcp.kiloapps.io/mcp' as const,
  token: 'renewed-session-mcp-token',
  expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
};

describe('Kilo v2 harness MCP refresh', () => {
  it('sends a slash command in the native command payload', async () => {
    const { url, requests } = startStub(() => new Response(null, { status: 204 }));
    const sessionId = `ses_${'a'.repeat(26)}`;
    await createHarness(url).command({
      sessionId,
      directory,
      command: 'review',
      args: 'src/app.ts',
      messageId: `msg_${'b'.repeat(26)}`,
    });
    expect(requests.map(request => [request.pathname, request.body])).toEqual([
      [
        `/api/experimental/session/${sessionId}/instructions/entries/cloud-agent-context`,
        { value: '' },
      ],
      [`/api/session/${sessionId}/command`, { command: 'review', text: 'src/app.ts' }],
    ]);
  });

  it('stores server context as a session instruction without changing user messages', async () => {
    const { url, requests } = startStub(() => new Response(null, { status: 204 }));
    const sessionId = `ses_${'a'.repeat(26)}`;
    const harness = createHarness(url);
    const context = '<cloud-agent-context session-id="workspace_1" />';
    await harness.submit({
      sessionId,
      directory,
      messageId: `msg_${'b'.repeat(26)}`,
      prompt: 'Summarize the change',
      context,
    });
    await harness.submit({
      sessionId,
      directory,
      messageId: `msg_${'c'.repeat(26)}`,
      parts: [
        { type: 'text', text: 'Explain this image' },
        {
          type: 'file',
          url: 'https://example.com/image.png',
          mime: 'image/png',
          filename: 'image.png',
        },
        { type: 'text', text: 'Keep it brief' },
      ],
      context,
    });
    expect(requests.map(request => [request.method, request.pathname, request.body])).toEqual([
      [
        'PUT',
        `/api/experimental/session/${sessionId}/instructions/entries/cloud-agent-context`,
        { value: context },
      ],
      [
        'POST',
        `/api/session/${sessionId}/prompt`,
        {
          id: `msg_${'b'.repeat(26)}`,
          text: 'Summarize the change',
          delivery: 'steer',
        },
      ],
      [
        'PUT',
        `/api/experimental/session/${sessionId}/instructions/entries/cloud-agent-context`,
        { value: context },
      ],
      [
        'POST',
        `/api/session/${sessionId}/prompt`,
        {
          id: `msg_${'c'.repeat(26)}`,
          text: 'Explain this image\nKeep it brief',
          files: [{ uri: 'https://example.com/image.png', name: 'image.png' }],
          delivery: 'steer',
        },
      ],
    ]);
  });

  it('clears the instruction before submitting a prompt without server context', async () => {
    const { url, requests } = startStub(() => new Response(null, { status: 204 }));
    await createHarness(url).submit({
      sessionId: 'ses_no_context',
      directory,
      messageId: 'msg_no_context',
      prompt: 'Hello',
    });
    expect(requests.map(request => [request.method, request.pathname, request.body])).toEqual([
      [
        'PUT',
        '/api/experimental/session/ses_no_context/instructions/entries/cloud-agent-context',
        { value: '' },
      ],
      [
        'POST',
        '/api/session/ses_no_context/prompt',
        { id: 'msg_no_context', text: 'Hello', delivery: 'steer' },
      ],
    ]);
  });

  it.each([undefined, '', '<cloud-agent-context session-id="workspace_1" />'])(
    'replaces a one-shot startup-failure note with the next context %p after harness recreation',
    async context => {
      const { url, requests } = startStub(() => new Response(null, { status: 204 }));
      const sessionId = 'ses_context_replacement';
      const initialContext =
        'Some startup commands failed during session preparation. The session started anyway.\n\n' +
        '<cloud-agent-context session-id="workspace_1" />';
      await createHarness(url).submit({
        sessionId,
        directory,
        messageId: 'msg_initial_context',
        prompt: 'First prompt',
        context: initialContext,
      });
      await createHarness(url).submit({
        sessionId,
        directory,
        messageId: 'msg_next_context',
        prompt: 'Next prompt',
        context,
      });
      expect(requests.map(request => [request.method, request.pathname, request.body])).toEqual([
        [
          'PUT',
          `/api/experimental/session/${sessionId}/instructions/entries/cloud-agent-context`,
          { value: initialContext },
        ],
        [
          'POST',
          `/api/session/${sessionId}/prompt`,
          { id: 'msg_initial_context', text: 'First prompt', delivery: 'steer' },
        ],
        [
          'PUT',
          `/api/experimental/session/${sessionId}/instructions/entries/cloud-agent-context`,
          { value: context ?? '' },
        ],
        [
          'POST',
          `/api/session/${sessionId}/prompt`,
          { id: 'msg_next_context', text: 'Next prompt', delivery: 'steer' },
        ],
      ]);
    }
  );

  it.each(['Callback routing context', undefined])(
    'does not submit a prompt if server context %p could not be replaced',
    async context => {
      const { url, requests } = startStub(() => new Response(null, { status: 503 }));
      const error: unknown = await createHarness(url)
        .submit({
          sessionId: 'ses_context_failure',
          directory,
          messageId: 'msg_context_failure',
          prompt: 'Hello',
          context,
        })
        .catch(cause => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('HTTP 503');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('PUT');
    }
  );

  it.each(['command', 'compact', 'condense'] as const)(
    'clears a prior prompt context before %s after harness recreation',
    async operation => {
      const sessionId = 'ses_non_prompt_context';
      const instructionPath = `/api/experimental/session/${sessionId}/instructions/entries/cloud-agent-context`;
      const { url, requests } = startStub((_request, url) =>
        url.pathname.includes('/message/')
          ? Response.json({ data: { type: 'compaction', status: 'completed' } })
          : new Response(null, { status: 204 })
      );
      await createHarness(url).submit({
        sessionId,
        directory,
        messageId: 'msg_startup_failure',
        prompt: 'First prompt',
        context: 'Some startup commands failed during session preparation.',
      });
      const harness = createHarness(url);
      const input = { sessionId, directory, model: 'test-model' };
      if (operation === 'command') await harness.command({ ...input, command: 'review' });
      else if (operation === 'compact') expect(await harness.compact(input)).toBe(true);
      else expect(await harness.condense(input)).toEqual({ success: true, wasAborted: false });

      const subsequentRequests = requests.slice(2);
      const clearIndex = subsequentRequests.findIndex(
        request => request.pathname === instructionPath
      );
      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(subsequentRequests[clearIndex]).toMatchObject({ method: 'PUT', body: { value: '' } });
      const nativePath = `/api/session/${sessionId}/${operation === 'command' ? 'command' : 'compact'}`;
      expect(
        subsequentRequests.findIndex(request => request.pathname === nativePath)
      ).toBeGreaterThan(clearIndex);
    }
  );

  it.each(['command', 'compact', 'condense'] as const)(
    'does not run %s if the prior prompt context cannot be cleared',
    async operation => {
      const { url, requests } = startStub(
        (_request, url) =>
          new Response(null, { status: url.pathname.includes('/instructions/') ? 503 : 204 })
      );
      const harness = createHarness(url);
      const input = { sessionId: 'ses_clear_failure', directory, model: 'test-model' };
      if (operation === 'condense') {
        const result = await harness.condense(input);
        expect(result.success).toBe(false);
        expect(result.error).toContain('HTTP 503');
      } else {
        const result =
          operation === 'command'
            ? harness.command({ ...input, command: 'review' })
            : harness.compact(input);
        const error: unknown = await result.catch(cause => cause);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('HTTP 503');
      }
      expect(requests.at(-1)?.pathname).toContain('/instructions/entries/cloud-agent-context');
      expect(requests.some(request => /\/(command|compact)$/.test(request.pathname))).toBe(false);
    }
  );

  it('replaces the running CLI MCP connection through the native runtime route', async () => {
    const stub = startStub((request, url) =>
      request.method === 'PUT'
        ? new Response(null, { status: 204 })
        : url.pathname === '/api/mcp'
          ? statusResponse('connected')
          : new Response(null, { status: 404 })
    );
    await createHarness(stub.url).updateCloudAgentMcp(credential);
    expect(stub.requests).toEqual([
      {
        method: 'PUT',
        pathname: '/api/experimental/mcp/kilo-cloud-agent',
        directory,
        authorization: 'Basic harness-test',
        body: {
          config: {
            type: 'remote',
            url: 'https://mcp.kiloapps.io/mcp',
            oauth: false,
            headers: { Authorization: 'Bearer renewed-session-mcp-token' },
          },
        },
      },
      {
        method: 'GET',
        pathname: '/api/mcp',
        directory,
        authorization: 'Basic harness-test',
        body: undefined,
      },
    ]);
  });

  it('retries a transient MCP connection failure without changing the issued credential', async () => {
    let reads = 0;
    const stub = startStub((request, url) => {
      if (request.method === 'PUT') return new Response(null, { status: 204 });
      if (url.pathname !== '/api/mcp') return new Response(null, { status: 404 });
      reads++;
      return statusResponse(reads === 1 ? 'failed' : 'connected', 'transient failure');
    });
    await createHarness(stub.url).updateCloudAgentMcp(credential);
    expect(reads).toBe(2);
    expect(stub.requests.filter(request => request.method === 'PUT')).toHaveLength(2);
  });

  it.each(['failed', 'needs_auth', 'disabled'])(
    'rejects an HTTP-successful but unavailable MCP status %s after bounded retry without leaking the credential',
    async status => {
      const stub = startStub((request, url) =>
        request.method === 'PUT'
          ? new Response(null, { status: 204 })
          : url.pathname === '/api/mcp'
            ? statusResponse(status, 'private-scoped-mcp-token')
            : new Response(null, { status: 404 })
      );
      const error: unknown = await createHarness(stub.url)
        .updateCloudAgentMcp({ ...credential, token: 'private-scoped-mcp-token' })
        .catch(cause => cause);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected credential refresh failure');
      expect(error.message).toBe('Cloud Agent MCP credential refresh failed');
      expect(String(error.stack ?? error)).not.toContain('private-scoped-mcp-token');
      expect(stub.requests.filter(request => request.method === 'PUT')).toHaveLength(2);
      expect(stub.requests.filter(request => request.method === 'GET')).toHaveLength(2);
    }
  );

  it('rejects a non-OK runtime add response with a bounded retry and no credential leak', async () => {
    const stub = startStub(() =>
      Response.json({ message: 'private-scoped-mcp-token' }, { status: 400 })
    );
    const error: unknown = await createHarness(stub.url)
      .updateCloudAgentMcp({ ...credential, token: 'private-scoped-mcp-token' })
      .catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected credential refresh failure');
    expect(error.message).toBe('Cloud Agent MCP credential refresh failed');
    expect(stub.requests).toHaveLength(2);
  });

  it('honors cancellation before issuing a runtime add', () => {
    const stub = startStub(() => new Response(null, { status: 204 }));
    const controller = new AbortController();
    controller.abort();
    expect(
      createHarness(stub.url).updateCloudAgentMcp(credential, controller.signal)
    ).rejects.toThrow();
    expect(stub.requests).toHaveLength(0);
  });
});

describe('Kilo v2 harness release', () => {
  it('releases the root and a bounded set of descendants from an oversized tree', async () => {
    const session = (id: string, parentID?: string) => ({
      id,
      ...(parentID ? { parentID } : {}),
      location: { directory },
      time: { created: 1, updated: 1 },
    });
    const children = Array.from({ length: 70 }, (_, index) =>
      session(`ses_child${index}`, 'ses_root')
    );
    const stub = startStub((_request, url) => {
      if (url.pathname === '/api/session')
        return Response.json({ data: [session('ses_root'), ...children], cursor: { next: null } });
      if (url.pathname.endsWith('/interrupt')) return Response.json({ interrupted: false });
      if (url.pathname === '/api/session/active') return Response.json({ data: {} });
      if (url.pathname.endsWith('/terminal')) return Response.json({ data: [] });
      return new Response(null, { status: 404 });
    });
    const result = await createHarness(stub.url).release({
      sessionId: 'ses_root',
      directory,
      signal: AbortSignal.timeout(5000),
      deadlineMs: 5000,
    });
    expect(result).toMatchObject({ ok: false, sessions: 64, failures: 7 });
    expect(
      stub.requests.some(request => request.pathname === '/api/session/ses_root/interrupt')
    ).toBe(true);
  });
});
