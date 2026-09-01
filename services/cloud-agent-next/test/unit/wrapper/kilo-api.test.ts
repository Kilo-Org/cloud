import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createWrapperKiloClient,
  type KiloEvent,
  type WrapperKiloClient,
} from '../../../wrapper/src/kilo-api.js';
import { createKiloClient, type KiloClient as SDKClient } from '@kilocode/sdk';
import type { SessionCommandResponse, SessionPromptResponse } from '@kilocode/sdk/v2';
import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

function createSdkClient(): SDKClient {
  return createKiloClient({ baseUrl: 'http://127.0.0.1:0' });
}

const workspacePath = '/workspace/project';
const nativeProjectId = '57ccd1e3429a492e139d0882b4767d0830996221';
const completion: SessionPromptResponse = {
  info: {
    id: 'msg_assistant',
    sessionID: 'kilo_sess',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'msg_prompt',
    modelID: 'vendor/model',
    providerID: 'kilo',
    mode: 'code',
    agent: 'code',
    path: { cwd: workspacePath, root: workspacePath },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
  },
  parts: [
    {
      id: 'part_assistant',
      sessionID: 'kilo_sess',
      messageID: 'msg_assistant',
      type: 'text',
      text: 'Completed',
    },
  ],
};

describe('createWrapperKiloClient prompt handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the typed prompt completion and shares serialization with the legacy async API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(completion))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);
    const opts: Parameters<WrapperKiloClient['sendPrompt']>[0] = {
      sessionId: 'kilo_sess',
      messageId: 'msg_prompt',
      directory: '/workspace/attached repo & tests',
      prompt: 'ignored when parts are present',
      parts: [
        { type: 'text', text: 'Review this file' },
        {
          type: 'file',
          mime: 'text/plain',
          url: 'data:text/plain;base64,aGVsbG8=',
          filename: 'a.txt',
        },
      ],
      model: { modelID: 'vendor/Team/Model:free~Alias' },
      agent: 'architect',
      variant: 'high',
      system: 'Review only',
      tools: { bash: false },
      snapshotInitialization: 'wait',
    };

    const result = await client.sendPrompt(opts);
    expectTypeOf(result).toEqualTypeOf<SessionPromptResponse>();
    expect(result).toEqual(completion);
    expect(result.info.parentID).toBe('msg_prompt');
    await expect(client.sendPromptAsync(opts)).resolves.toBeUndefined();

    const requests = fetchMock.mock.calls.map(([request]) => request as Request);
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/session/kilo_sess/message',
      '/session/kilo_sess/prompt_async',
    ]);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(new URL(request.url).searchParams.get('directory')).toBe(opts.directory);
      await expect(request.json()).resolves.toEqual({
        messageID: 'msg_prompt',
        parts: opts.parts,
        model: { providerID: 'kilo', modelID: 'vendor/Team/Model:free~Alias' },
        agent: 'architect',
        variant: 'high',
        system: 'Review only',
        tools: { bash: false },
        snapshotInitialization: 'wait',
      });
    }
  });

  it('preserves typed assistant errors in both completion APIs for the wrapper to inspect', async () => {
    const failedCompletion: SessionPromptResponse = {
      ...completion,
      info: {
        ...completion.info,
        error: { name: 'APIError', data: { message: 'Provider failed', isRetryable: false } },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(failedCompletion)))
    );
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    const prompt = await client.sendPrompt({
      sessionId: 'kilo_sess',
      messageId: 'msg_prompt',
      prompt: 'hello',
    });
    const command = await client.sendCommand({ sessionId: 'kilo_sess', command: 'review' });

    expectTypeOf(prompt).toEqualTypeOf<SessionPromptResponse>();
    expectTypeOf(command).toEqualTypeOf<SessionCommandResponse>();
    expect(prompt.info.error).toEqual(failedCompletion.info.error);
    expect(command.info.error).toEqual(failedCompletion.info.error);
    expect(prompt).toEqual(failedCompletion);
    expect(command).toEqual(failedCompletion);
  });

  it.each(['prompt', 'command'] as const)(
    '%s completion requires response data',
    async operation => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(Response.json(null));
      vi.stubGlobal('fetch', fetchMock);
      const client = createWrapperKiloClient(
        createSdkClient(),
        'http://127.0.0.1:0',
        workspacePath
      );
      const invoke = () =>
        operation === 'prompt'
          ? client.sendPrompt({ sessionId: 'kilo_sess', messageId: 'msg_prompt', prompt: 'hello' })
          : client.sendCommand({ sessionId: 'kilo_sess', command: 'review' });

      await expect(invoke()).rejects.toThrow('returned no data');
      await expect(invoke()).rejects.toThrow('returned no data');
    }
  );

  it('throws when the command SDK response contains an error result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'command rejected' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(
      client.sendCommand({ sessionId: 'kilo_sess', command: 'compact', messageId: 'msg_command' })
    ).rejects.toThrow('Command for session kilo_sess failed: HTTP 409');
  });

  it('serializes an opaque gateway model through the pinned prompt and command SDK requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(completion));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);
    const model = { providerID: 'kilo', modelID: 'vendor/Team/Model:free~Alias' };

    await client.sendPromptAsync({
      sessionId: 'kilo_sess',
      messageId: 'msg_prompt',
      prompt: 'hello',
      model,
      agent: 'architect',
      variant: 'high',
    });
    await client.sendCommand({
      sessionId: 'kilo_sess',
      messageId: 'msg_command',
      command: 'review',
      args: '--all changes',
      model,
      agent: 'architect',
      variant: 'high',
    });

    const requests = fetchMock.mock.calls.map(([request]) => {
      expect(request).toBeInstanceOf(Request);
      return request as Request;
    });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', '/session/kilo_sess/prompt_async'],
      ['POST', '/session/kilo_sess/command'],
    ]);
    await expect(Promise.all(requests.map(request => request.clone().json()))).resolves.toEqual([
      {
        messageID: 'msg_prompt',
        parts: [{ type: 'text', text: 'hello' }],
        model: { providerID: 'kilo', modelID: 'vendor/Team/Model:free~Alias' },
        agent: 'architect',
        variant: 'high',
      },
      {
        messageID: 'msg_command',
        command: 'review',
        arguments: '--all changes',
        model: 'kilo/vendor/Team/Model:free~Alias',
        agent: 'architect',
        variant: 'high',
      },
    ]);
  });

  it('defaults a selected command model to the Kilo provider without stripping an inner kilo prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(completion));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.sendCommand({
      sessionId: 'kilo_sess',
      command: 'review',
      model: { modelID: 'kilo/example' },
    });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect((request as Request).clone().json()).resolves.toEqual({
      command: 'review',
      arguments: '',
      model: 'kilo/kilo/example',
    });
  });

  it('leaves the command model absent when only agent and variant are selected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(completion));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.sendCommand({
      sessionId: 'kilo_sess',
      command: 'review',
      agent: 'reviewer',
      variant: 'high',
    });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect((request as Request).clone().json()).resolves.toEqual({
      command: 'review',
      arguments: '',
      agent: 'reviewer',
      variant: 'high',
    });
  });

  it('summarizes sessions through the dedicated Kilo endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(true), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    const result = await client.summarizeSession({
      sessionId: 'kilo_sess',
      model: { modelID: 'anthropic/claude-sonnet-4-20250514' },
    });

    expect(result).toBe(true);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    const url = new URL((request as Request).url);
    expect(url.pathname).toBe('/session/kilo_sess/summarize');
    expect(url.searchParams.get('directory')).toBe(workspacePath);
    await expect((request as Request).clone().json()).resolves.toEqual({
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4-20250514',
    });
  });

  it.each([true, false])(
    'preserves summarize auto=%s, model, and attached directory',
    async auto => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json(true));
      vi.stubGlobal('fetch', fetchMock);
      const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');
      const directory = '/workspace/attached repo & tests';

      await expect(
        client.summarizeSession({
          sessionId: 'kilo_sess',
          model: { providerID: 'custom', modelID: 'vendor/Team/Model:free~Alias' },
          auto,
          directory,
        })
      ).resolves.toBe(true);

      const request = fetchMock.mock.calls[0]?.[0] as Request;
      expect(request.method).toBe('POST');
      const url = new URL(request.url);
      expect(url.pathname).toBe('/session/kilo_sess/summarize');
      expect(url.searchParams.get('directory')).toBe(directory);
      await expect(request.json()).resolves.toEqual({
        providerID: 'custom',
        modelID: 'vendor/Team/Model:free~Alias',
        auto,
      });
    }
  );

  it.each([null, 'null', '{}'])('rejects summarize without a boolean response: %s', async body => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } }))
    );
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(
      client.summarizeSession({ sessionId: 'kilo_sess', model: { modelID: 'vendor/model' } })
    ).rejects.toThrow(/Session summarize for kilo_sess returned no (data|boolean result)/);
  });

  it('returns the generated commit message and rejects missing SDK response data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: 'fix: preserve finalization' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(null));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);
    const opts = { path: '/workspace/attached repo & tests' };

    await expect(client.generateCommitMessage(opts)).resolves.toEqual({
      message: 'fix: preserve finalization',
    });
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/commit-message');
    await expect(request.json()).resolves.toEqual(opts);
    await expect(client.generateCommitMessage(opts)).rejects.toThrow(
      'Commit message generation returned no data'
    );
    await expect(client.generateCommitMessage(opts)).rejects.toThrow(
      'Commit message generation returned no data'
    );
  });

  it('rejects commit-generation HTTP failures so auto-commit can handle its fallback explicitly', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ message: 'private upstream detail' }, { status: 422 }))
    );
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(client.generateCommitMessage({ path: workspacePath })).rejects.toThrow(
      'Commit message generation failed: HTTP 422'
    );
  });

  it('throws when the SDK async prompt response contains an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'server rejected prompt' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(
      client.sendPromptAsync({
        sessionId: 'kilo_sess_rejected',
        messageId: 'msg_rejected',
        prompt: 'queue this prompt',
      })
    ).rejects.toThrow('Async prompt for session kilo_sess_rejected failed: HTTP 409');
  });

  it('passes snapshot wait policy through async prompt requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.sendPromptAsync({
      sessionId: 'kilo_sess_wait',
      messageId: 'msg_wait',
      prompt: 'queue this prompt',
      snapshotInitialization: 'wait',
    });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect((request as Request).clone().json()).resolves.toMatchObject({
      snapshotInitialization: 'wait',
    });
  });

  it('lists exact deduplicated effective model IDs for the requested provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'kilo',
            models: {
              'openai/gpt-5.1': {},
              'anthropic/claude-sonnet-4-20250514': {},
            },
          },
          {
            id: 'openai',
            models: {
              'gpt-5.1': {},
            },
          },
          {
            id: 'kilo',
            models: {
              'openai/gpt-5.1': {},
              'google/gemini-3-pro': {},
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(client.listEffectiveModels('kilo')).resolves.toEqual([
      'anthropic/claude-sonnet-4-20250514',
      'google/gemini-3-pro',
      'openai/gpt-5.1',
    ]);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    const url = new URL((request as Request).url);
    expect(url.pathname).toBe('/config/providers');
    expect(url.searchParams.get('directory')).toBe(workspacePath);
    expect(url.searchParams.get('workspace')).toBe(workspacePath);
  });

  it('passes snapshot wait policy through command requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.sendCommand({
      sessionId: 'kilo_sess_wait',
      command: 'review',
      args: 'selected changes',
      messageId: 'msg_wait',
      snapshotInitialization: 'wait',
    });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL((request as Request).url).pathname).toBe('/session/kilo_sess_wait/command');
    await expect((request as Request).clone().json()).resolves.toEqual({
      command: 'review',
      arguments: 'selected changes',
      messageID: 'msg_wait',
      snapshotInitialization: 'wait',
    });
  });

  it('omits snapshot wait policy from default command requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.sendCommand({ sessionId: 'kilo_sess_default', command: 'review' });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect((request as Request).clone().json()).resolves.toEqual({
      command: 'review',
      arguments: '',
    });
  });
});

describe('createWrapperKiloClient abort acknowledgement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([undefined, '0'])(
    'rejects empty JSON HTTP 200 with content-length %s',
    async contentLength => {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (contentLength !== undefined) headers.set('content-length', contentLength);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status: 200, headers }))
      );
      const client = createWrapperKiloClient(
        createSdkClient(),
        'http://127.0.0.1:0',
        workspacePath
      );

      await expect(client.abortSession({ sessionId: 'kilo_sess' })).rejects.toThrow(
        'Session abort for kilo_sess returned no boolean result'
      );
    }
  );
});

describe('createWrapperKiloClient session initialization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves an existing custom-titled session in its attached directory without importing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ id: 'kilo_sess', title: 'My chosen title' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');

    await client.ensureSession('kilo_sess', workspacePath);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/session/kilo_sess');
    expect(new URL(request.url).searchParams.get('directory')).toBe(workspacePath);
  });

  it('imports a missing session with an auto-title-eligible placeholder and scoped directory', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: 'missing' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: nativeProjectId }))
      .mockResolvedValueOnce(Response.json({ ok: true, id: 'kilo_sess' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');

    await client.ensureSession('kilo_sess', workspacePath);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = fetchMock.mock.calls.map(([request]) => request as Request);
    expect(requests.map(request => new URL(request.url).searchParams.get('directory'))).toEqual([
      workspacePath,
      workspacePath,
      workspacePath,
    ]);
    expect(new URL(requests[1].url).pathname).toBe('/project/current');
    const imported = requests[2];
    expect(imported.method).toBe('POST');
    expect(new URL(imported.url).pathname).toBe('/kilocode/session-import/session');
    const body = await imported.json();
    expect(isDefaultSessionTitle(body.title)).toBe(true);
    expect(body).toEqual({
      id: 'kilo_sess',
      projectID: nativeProjectId,
      slug: 'kilo_sess',
      directory: workspacePath,
      title: 'New session - ' + new Date(body.timeCreated).toISOString(),
      version: '7.4.20',
      timeCreated: expect.any(Number),
      timeUpdated: body.timeCreated,
    });
  });

  it('rejects import HTTP errors without echoing response payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ message: 'missing' }, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ id: nativeProjectId }))
        .mockResolvedValueOnce(Response.json({ message: 'sensitive import data' }, { status: 500 }))
    );
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');

    const error: unknown = await client
      .ensureSession('kilo_sess', workspacePath)
      .catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected import failure');
    expect(error.message).toBe('Session import for kilo_sess failed: HTTP 500');
  });

  it('requires the lookup to return the requested session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 'another_session' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');

    await expect(client.ensureSession('kilo_sess', workspacePath)).rejects.toThrow(
      'returned an invalid session'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires a successful import result, not just an HTTP success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ message: 'missing' }, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ id: nativeProjectId }))
        .mockResolvedValueOnce(Response.json({ ok: false, id: 'kilo_sess' }))
    );
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');

    await expect(client.ensureSession('kilo_sess', workspacePath)).rejects.toThrow(
      'Session import for kilo_sess returned an invalid session'
    );
  });
});

describe('createWrapperKiloClient generated SDK request cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const operations: Array<{
    name: string;
    initialNotFound?: boolean;
    invoke: (client: WrapperKiloClient, directory: string, signal: AbortSignal) => Promise<unknown>;
  }> = [
    {
      name: 'prompt completion',
      invoke: (client, directory, signal) =>
        client.sendPrompt({
          sessionId: 'kilo_sess',
          messageId: 'msg_prompt',
          prompt: 'hello',
          directory,
          signal,
        }),
    },
    {
      name: 'legacy async prompt',
      invoke: (client, directory, signal) =>
        client.sendPromptAsync({
          sessionId: 'kilo_sess',
          messageId: 'msg_prompt',
          prompt: 'hello',
          directory,
          signal,
        }),
    },
    {
      name: 'command completion',
      invoke: (client, directory, signal) =>
        client.sendCommand({ sessionId: 'kilo_sess', command: 'review', directory, signal }),
    },
    {
      name: 'session abort',
      invoke: (client, directory, signal) =>
        client.abortSession({ sessionId: 'kilo_sess', directory, signal }),
    },
    {
      name: 'session summarize',
      invoke: (client, directory, signal) =>
        client.summarizeSession({
          sessionId: 'kilo_sess',
          model: { modelID: 'vendor/model' },
          directory,
          signal,
        }),
    },
    {
      name: 'session status',
      invoke: (client, directory, signal) => client.getSessionStatuses(directory, signal),
    },
    {
      name: 'question list',
      invoke: (client, directory, signal) => client.getQuestions(directory, signal),
    },
    {
      name: 'permission list',
      invoke: (client, directory, signal) => client.getPermissions(directory, signal),
    },
    {
      name: 'question reply',
      invoke: (client, directory, signal) =>
        client.answerQuestion('question_1', [['All']], directory, signal),
    },
    {
      name: 'question rejection',
      invoke: (client, directory, signal) => client.rejectQuestion('question_1', directory, signal),
    },
    {
      name: 'permission reply',
      invoke: (client, directory, signal) =>
        client.answerPermission('permission_1', 'once', undefined, true, directory, signal),
    },
    {
      name: 'session lookup',
      invoke: (client, directory, signal) => client.ensureSession('kilo_sess', directory, signal),
    },
    {
      name: 'session project lookup',
      initialNotFound: true,
      invoke: (client, directory, signal) => client.ensureSession('kilo_sess', directory, signal),
    },
    {
      name: 'session import',
      initialNotFound: true,
      invoke: (client, directory, signal) => client.ensureSession('kilo_sess', directory, signal),
    },
  ];

  for (const operation of operations) {
    it(`${operation.name} forwards its directory and aborts the in-flight fetch`, async () => {
      const received = Promise.withResolvers<Request>();
      const fetchMock = vi.fn((request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (
          operation.initialNotFound &&
          request.method === 'GET' &&
          pathname.startsWith('/session/')
        ) {
          return Promise.resolve(Response.json({ message: 'missing' }, { status: 404 }));
        }
        if (operation.name === 'session import' && pathname === '/project/current') {
          return Promise.resolve(Response.json({ id: nativeProjectId }));
        }
        received.resolve(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', '/');
      const directory = '/workspace/attached repo & tests';
      const controller = new AbortController();
      const reason = new Error('cancel request');
      const pending = operation
        .invoke(client, directory, controller.signal)
        .catch((error: unknown) => error);
      const request = await received.promise;

      expect(new URL(request.url).searchParams.get('directory')).toBe(directory);
      expect(request.signal.aborted).toBe(false);
      controller.abort(reason);
      expect(request.signal.aborted).toBe(true);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected cancellation failure');
      expect(error.cause).toBe(reason);
      expect(error.message).toMatch(/failed: request error$/);
      expect(fetchMock).toHaveBeenCalledTimes(
        operation.name === 'session import' ? 3 : operation.initialNotFound ? 2 : 1
      );
    });
  }
});

describe('createWrapperKiloClient network endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws instead of returning an empty network snapshot on an SDK error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'server rejected list' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(client.getNetworkWaits()).rejects.toThrow('Network list failed: HTTP 500');
  });

  it('throws when the SDK network reply response contains an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'missing network wait' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await expect(client.resumeNetworkWait('net_req_missing')).rejects.toThrow(
      'Network reply net_req_missing failed: HTTP 404'
    );
  });
});

describe('createWrapperKiloClient event subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps global synthetic events that omit properties', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            'data: {"payload":{"type":"server.connected"}}',
            '',
            'data: {"directory":"/workspace/other","payload":{"type":"session.idle","properties":{"sessionID":"other"}}}',
            '',
            'data: {"directory":"/workspace/project","payload":{"type":"message.updated","properties":{"id":"msg_1"}}}',
            '',
            'data: {"payload":{"type":"server.heartbeat"}}',
            '',
            '',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    const { stream } = await client.subscribeEvents({});
    if (!stream) throw new Error('Expected event stream');

    const events: KiloEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL((request as Request).url).pathname).toBe('/global/event');
    expect(events).toEqual([
      { type: 'server.connected' },
      { type: 'message.updated', properties: { id: 'msg_1' } },
      { type: 'server.heartbeat' },
    ]);
  });
});

describe('createWrapperKiloClient PTY endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resizes PTYs within the configured workspace directory', async () => {
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(input => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        requestedUrls.push(new URL(requestUrl));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'pty_resize',
              title: 'Workspace terminal',
              command: '/bin/bash',
              args: [],
              cwd: workspacePath,
              status: 'running',
              pid: 42,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      })
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.resizePty('pty_resize', { cols: 120, rows: 40 });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.searchParams.get('directory')).toBe(workspacePath);
  });

  it('resizes PTYs within an explicitly supplied session directory', async () => {
    const sessionDirectory = '/workspace/control-session';
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(input => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        requestedUrls.push(new URL(requestUrl));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'pty_resize_control',
              title: 'Workspace terminal',
              command: '/bin/bash',
              args: [],
              cwd: sessionDirectory,
              status: 'running',
              pid: 43,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      })
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.resizePty('pty_resize_control', { cols: 100, rows: 35 }, sessionDirectory);

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.pathname).toBe('/pty/pty_resize_control');
    expect(requestedUrls[0]?.searchParams.get('directory')).toBe(sessionDirectory);
  });

  it('deletes PTYs within the configured workspace directory', async () => {
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(input => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        requestedUrls.push(new URL(requestUrl));
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      })
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.deletePty('pty_delete');

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.searchParams.get('directory')).toBe(workspacePath);
  });

  it('deletes PTYs within an explicitly supplied session directory', async () => {
    const sessionDirectory = '/workspace/another-control-session';
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(input => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        requestedUrls.push(new URL(requestUrl));
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      })
    );

    const client = createWrapperKiloClient(createSdkClient(), 'http://127.0.0.1:0', workspacePath);

    await client.deletePty('pty_delete_control', sessionDirectory);

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.pathname).toBe('/pty/pty_delete_control');
    expect(requestedUrls[0]?.searchParams.get('directory')).toBe(sessionDirectory);
  });
});
