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
    const sdkClient = {
      session: {
        command: vi.fn().mockResolvedValue({ error: { message: 'command rejected' } }),
      },
    } as unknown as SDKClient;
    const client = createWrapperKiloClient(sdkClient, 'http://127.0.0.1:0', workspacePath);

    await expect(
      client.sendCommand({ sessionId: 'kilo_sess', command: 'compact', messageId: 'msg_command' })
    ).rejects.toThrow('Command for session kilo_sess failed: command rejected');
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
