import { describe, expect, it, vi } from 'vitest';
import { VercelWrapperTransport } from './vercel-wrapper-transport.js';
import type { VercelSandboxRestClient } from './vercel-sandbox-rest-client.js';

const sessionId = 'sbox_session_exact';
const secretBody = { prompt: 'private prompt', token: 'secret-token' };

type RestClientDouble = {
  writeFiles: ReturnType<typeof vi.fn>;
  executeCommand: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
};

function transportFor(overrides: Partial<RestClientDouble> = {}) {
  const restClient = {
    writeFiles: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({
      command: { id: 'cmd_1' },
      finished: { id: 'cmd_1', exitCode: 0 },
    }),
    readFile: vi
      .fn()
      .mockResolvedValueOnce(new TextEncoder().encode('{"status":"sent"}'))
      .mockResolvedValueOnce(new TextEncoder().encode('202')),
    ...overrides,
  };
  return {
    restClient,
    transport: new VercelWrapperTransport({
      restClient: restClient as unknown as VercelSandboxRestClient,
      sessionId,
      port: 5000,
      randomId: () => 'safeRandom123',
    }),
  };
}

describe('VercelWrapperTransport', () => {
  it('stages private bodies, executes bun in the exact session, preserves status, and cleans up', async () => {
    const { restClient, transport } = transportFor();

    const response = await transport.request('POST', '/job/prompt', secretBody);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'sent' });
    expect(restClient.writeFiles).toHaveBeenCalledWith(sessionId, '/tmp', [
      {
        path: 'kilo-wrapper-safeRandom123/request.json',
        content: JSON.stringify(secretBody),
      },
    ]);
    const executeCalls = vi.mocked(restClient.executeCommand).mock.calls;
    expect(executeCalls[0][0]).toBe(sessionId);
    expect(executeCalls[0][1]).toMatchObject({
      command: 'bun',
      args: ['-e', expect.stringContaining('await fetch(url, init)')],
      env: {
        KILO_WRAPPER_METHOD: 'POST',
        KILO_WRAPPER_URL: 'http://127.0.0.1:5000/job/prompt',
        KILO_WRAPPER_RESPONSE: '/tmp/kilo-wrapper-safeRandom123/response.json',
        KILO_WRAPPER_STATUS: '/tmp/kilo-wrapper-safeRandom123/status.txt',
        KILO_WRAPPER_REQUEST: '/tmp/kilo-wrapper-safeRandom123/request.json',
      },
      wait: true,
    });
    expect(executeCalls[1][1]).toMatchObject({
      command: 'rm',
      args: ['-rf', '--', '/tmp/kilo-wrapper-safeRandom123'],
      wait: true,
    });
    expect(JSON.stringify(executeCalls)).not.toContain('private prompt');
    expect(JSON.stringify(executeCalls)).not.toContain('secret-token');
  });

  it('always removes staged files when bun or response reads fail without leaking bodies', async () => {
    const providerError = new Error('exact-session command failed');
    const { restClient, transport } = transportFor({
      executeCommand: vi
        .fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce({ command: {}, finished: { exitCode: 0 } }),
    });

    await expect(transport.request('POST', '/session/ready', secretBody)).rejects.toBe(
      providerError
    );
    expect(restClient.executeCommand).toHaveBeenLastCalledWith(
      sessionId,
      expect.objectContaining({
        command: 'rm',
        args: ['-rf', '--', '/tmp/kilo-wrapper-safeRandom123'],
      })
    );
    await expect(transport.request('POST', '/job/prompt', secretBody)).rejects.not.toThrow(
      /private prompt|secret-token/
    );
  });

  it('bounds response and status reads and uses the long readiness timeout', async () => {
    const { restClient, transport } = transportFor();

    await transport.request('POST', '/session/ready', {});

    expect(restClient.executeCommand).toHaveBeenNthCalledWith(
      1,
      sessionId,
      expect.objectContaining({ timeoutMs: 120_000 })
    );
    expect(restClient.readFile).toHaveBeenNthCalledWith(
      1,
      sessionId,
      '/tmp/kilo-wrapper-safeRandom123/response.json',
      1024 * 1024
    );
    expect(restClient.readFile).toHaveBeenNthCalledWith(
      2,
      sessionId,
      '/tmp/kilo-wrapper-safeRandom123/status.txt',
      3
    );
  });
});
