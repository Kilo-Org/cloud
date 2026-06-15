import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import type { KiloClient as SDKClient } from '@kilocode/sdk';

function createSdkClient(): SDKClient {
  return {
    session: {},
  } as SDKClient;
}

const workspacePath = '/workspace/project';

describe('createWrapperKiloClient prompt handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    ).rejects.toThrow('Command for session kilo_sess failed: command rejected');
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
    await expect((request as Request).clone().json()).resolves.toEqual({
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4-20250514',
    });
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
    ).rejects.toThrow('Async prompt for session kilo_sess_rejected failed: server rejected prompt');
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
      new Response(JSON.stringify({}), {
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
      new Response(JSON.stringify({}), {
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

describe('createWrapperKiloClient network endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty list when the SDK network list response contains an error', async () => {
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

    await expect(client.getNetworkWaits()).resolves.toEqual([]);
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
      'Network reply net_req_missing failed: missing network wait'
    );
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
});
