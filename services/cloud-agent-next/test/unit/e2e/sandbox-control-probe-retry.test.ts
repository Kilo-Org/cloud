import { describe, expect, it, vi } from 'vitest';

import {
  inspectControlPlaneWorkspaceFile,
  type ControlPlaneKiloRuntime,
  type DockerCommandExecutor,
  type SandboxContainer,
} from '../../e2e/sandbox-control.js';

const container: SandboxContainer = {
  id: 'container-1',
  name: 'cloud-agent-next-dev-Sandbox-1',
  image: 'cloudflare/sandbox:latest',
  isProxy: false,
};

const runtime: ControlPlaneKiloRuntime = {
  container,
  kiloSessionId: 'ses_1',
  serverUrl: 'http://127.0.0.1:4096',
  directory: '/worktrees/ws',
  home: '/home/ws',
  processId: 7,
};

type ScriptedExecResult = { ok: true; [key: string]: unknown } | { ok: false; reason: string };

function dockerPsOutput(containers: SandboxContainer[]): string {
  return containers.map(entry => `${entry.id}\t${entry.name}\t${entry.image}`).join('\n');
}

/**
 * A Docker executor whose in-container script result is scripted per `exec`
 * call (the last entry repeats). `docker ps` reports the given containers so a
 * caller's gone-container classification sees a live container.
 */
function scriptedExecutor(options: {
  execResults: ScriptedExecResult[];
  containers?: SandboxContainer[];
  onExec?: (request: Record<string, unknown>) => void;
}): DockerCommandExecutor {
  let execCalls = 0;
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'ps') return { stdout: dockerPsOutput(options.containers ?? []) };
    if (args[0] === 'exec') {
      options.onExec?.(JSON.parse(args[5] ?? '{}') as Record<string, unknown>);
      const result = options.execResults[Math.min(execCalls, options.execResults.length - 1)];
      execCalls += 1;
      return { stdout: JSON.stringify(result) };
    }
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  });
}

function execCallCount(executeDocker: DockerCommandExecutor): number {
  const mock = executeDocker as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.filter(call => Array.isArray(call[0]) && call[0][0] === 'exec').length;
}

const fileInput = { kiloSessionId: 'ses_1', filePath: 'long-session/turn0.txt' };

describe('control-plane probe timeout retry', () => {
  it('retries a transient in-container timeout and returns the file state', async () => {
    const executeDocker = scriptedExecutor({
      execResults: [
        { ok: false, reason: 'file failed (TimeoutError)' },
        { ok: true, exists: true, dirty: true, head: 'abc123', contents: 'hello' },
      ],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).resolves.toEqual({ exists: true, dirty: true, head: 'abc123', contents: 'hello' });
    expect(execCallCount(executeDocker)).toBe(2);
  });

  it('does not retry a non-timeout failure', async () => {
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [{ ok: false, reason: 'file failed (TypeError)' }],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).rejects.toThrow('Kilo file failed: file failed (TypeError)');
    expect(execCallCount(executeDocker)).toBe(1);
  });

  it('bounds retries and surfaces a persistent timeout', async () => {
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [
        { ok: false, reason: 'file failed (TimeoutError)' },
        { ok: false, reason: 'file failed (TimeoutError)' },
      ],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).rejects.toThrow('file failed (TimeoutError)');
    expect(execCallCount(executeDocker)).toBe(2);
  });

  it('re-anchors a read-only probe to a rotated listener in the same container', async () => {
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [
        { ok: false, reason: 'Owned Kilo listener identity did not match' },
        {
          ok: true,
          matched: true,
          kiloSessionId: 'ses_1',
          serverUrl: 'http://127.0.0.1:4999',
          directory: '/worktrees/ws',
          home: '/home/ws',
          processId: 99,
        },
        { ok: true, exists: true, dirty: false, head: 'rotated', contents: 'fresh' },
      ],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).resolves.toEqual({ exists: true, dirty: false, head: 'rotated', contents: 'fresh' });
    expect(execCallCount(executeDocker)).toBe(3);
  });

  it('does not re-anchor when the rotated root cannot be re-discovered', async () => {
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [
        { ok: false, reason: 'Owned Kilo listener identity did not match' },
        { ok: true, matched: false },
      ],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).rejects.toThrow('Owned Kilo listener identity did not match');
    expect(execCallCount(executeDocker)).toBe(2);
  });

  it("re-anchors a read-only probe when the rotated listener's home changed", async () => {
    const requests: Record<string, unknown>[] = [];
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [
        { ok: false, reason: 'Owned Kilo listener identity did not match' },
        {
          ok: true,
          matched: true,
          kiloSessionId: 'ses_1',
          serverUrl: 'http://127.0.0.1:4999',
          directory: '/worktrees/ws',
          home: '/home/rotated',
          processId: 99,
        },
        { ok: true, exists: true, dirty: false, head: 'rotated', contents: 'fresh' },
      ],
      onExec: request => requests.push(request),
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).resolves.toEqual({ exists: true, dirty: false, head: 'rotated', contents: 'fresh' });
    expect(execCallCount(executeDocker)).toBe(3);
    // The re-anchored attempt must carry the rotated listener's full identity,
    // including its changed HOME, not the stale discovery values.
    expect(requests[2]).toMatchObject({
      action: 'file',
      serverUrl: 'http://127.0.0.1:4999',
      processId: 99,
      directory: '/worktrees/ws',
      home: '/home/rotated',
    });
  });

  it('does not re-anchor to a different root', async () => {
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [
        { ok: false, reason: 'Owned Kilo listener identity did not match' },
        {
          ok: true,
          matched: true,
          kiloSessionId: 'ses_other',
          serverUrl: 'http://127.0.0.1:4999',
          directory: '/worktrees/ws',
          home: '/home/rotated',
          processId: 99,
        },
        { ok: true, exists: true, dirty: false, head: 'rotated', contents: 'fresh' },
      ],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).rejects.toThrow('Owned Kilo listener identity did not match');
    expect(execCallCount(executeDocker)).toBe(2);
  });

  it('does not re-anchor to a different directory', async () => {
    const executeDocker = scriptedExecutor({
      containers: [container],
      execResults: [
        { ok: false, reason: 'Owned Kilo listener identity did not match' },
        {
          ok: true,
          matched: true,
          kiloSessionId: 'ses_1',
          serverUrl: 'http://127.0.0.1:4999',
          directory: '/worktrees/other',
          home: '/home/rotated',
          processId: 99,
        },
        { ok: true, exists: true, dirty: false, head: 'rotated', contents: 'fresh' },
      ],
    });

    await expect(
      inspectControlPlaneWorkspaceFile(runtime, fileInput, executeDocker)
    ).rejects.toThrow('Owned Kilo listener identity did not match');
    expect(execCallCount(executeDocker)).toBe(2);
  });
});
