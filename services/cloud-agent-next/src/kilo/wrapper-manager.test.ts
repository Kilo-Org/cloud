import { describe, expect, it, vi } from 'vitest';
import {
  extractPublishedWrapperPort,
  findWrapperContainerForSession,
  isWrapperLiveInProcessesOrContainers,
  listWrapperContainers,
  stopWrapper,
} from './wrapper-manager.js';

const mockExec = (impl: (cmd: string) => { exitCode: number; stdout?: string }) => ({
  exec: vi.fn(async (cmd: string) => impl(cmd)),
});

describe('extractPublishedWrapperPort', () => {
  it('parses 0.0.0.0:5050->5050/tcp', () => {
    expect(extractPublishedWrapperPort('0.0.0.0:5050->5050/tcp')).toBe(5050);
  });

  it('parses 127.0.0.1:5050->5050/tcp', () => {
    expect(extractPublishedWrapperPort('127.0.0.1:5050->5050/tcp')).toBe(5050);
  });

  it('returns null when no tcp publish is present', () => {
    expect(extractPublishedWrapperPort('')).toBeNull();
    expect(extractPublishedWrapperPort('5050/udp')).toBeNull();
  });

  it('returns the first valid mapping when multiple are listed', () => {
    expect(extractPublishedWrapperPort('0.0.0.0:9000->9000/tcp, 127.0.0.1:5050->5050/tcp')).toBe(
      9000
    );
  });

  it('ignores IPv6 mappings the docker runtime might emit alongside IPv4', () => {
    // We deliberately don't match `[::]:5050->5050/tcp`; an IPv4 binding is
    // always present beside it for published ports.
    expect(extractPublishedWrapperPort('[::]:5050->5050/tcp, 0.0.0.0:5050->5050/tcp')).toBe(5050);
  });
});

describe('listWrapperContainers', () => {
  it('returns an empty list when docker ps reports no rows', async () => {
    const sandbox = mockExec(() => ({ exitCode: 0, stdout: '' }));
    expect(await listWrapperContainers(sandbox)).toEqual([]);
  });

  it('returns an empty list when docker ps fails', async () => {
    const sandbox = mockExec(() => ({ exitCode: 1, stdout: '' }));
    expect(await listWrapperContainers(sandbox)).toEqual([]);
  });

  it('returns an empty list when docker exec throws (no docker binary)', async () => {
    const sandbox = {
      exec: vi.fn(() => Promise.reject(new Error('docker: command not found'))),
    };
    expect(await listWrapperContainers(sandbox)).toEqual([]);
  });

  it('parses a tab-separated docker ps row into agentSessionId + port', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'cont-deadbeef\t0.0.0.0:5050->5050/tcp\tkilo.agentSession=agent_abc\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([
      { containerId: 'cont-deadbeef', agentSessionId: 'agent_abc', port: 5050 },
    ]);
  });

  it('passes the resolved Docker socket env to docker ps', async () => {
    const sandbox = {
      exec: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/run/user/1000/docker.sock' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'cont-deadbeef\t127.0.0.1:5050->5050/tcp\tkilo.agentSession=agent_abc\n',
        }),
    };

    expect(await listWrapperContainers(sandbox)).toEqual([
      { containerId: 'cont-deadbeef', agentSessionId: 'agent_abc', port: 5050 },
    ]);
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, expect.stringContaining('docker ps'), {
      env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' },
    });
  });

  it('prefers the wrapper port label over unrelated published ports', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout:
        'cont-deadbeef\t0.0.0.0:3000->3000/tcp, 127.0.0.1:5050->5050/tcp\tkilo.agentSession=agent_abc,kilo.wrapperPort=5050\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([
      { containerId: 'cont-deadbeef', agentSessionId: 'agent_abc', port: 5050 },
    ]);
  });

  it('skips rows missing the agent-session label', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'cont-1\t0.0.0.0:5050->5050/tcp\tother.label=xyz\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([]);
  });

  it('skips rows with no published port', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'cont-2\t\tkilo.agentSession=agent_abc\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([]);
  });

  it('parses multiple rows', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout:
        'a\t0.0.0.0:5000->5000/tcp\tkilo.agentSession=agent_a\n' +
        'b\t127.0.0.1:5001->5001/tcp\tkilo.agentSession=agent_b\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([
      { containerId: 'a', agentSessionId: 'agent_a', port: 5000 },
      { containerId: 'b', agentSessionId: 'agent_b', port: 5001 },
    ]);
  });

  it('finds the agent-session label when other labels precede it', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'c\t0.0.0.0:5050->5050/tcp\tk1=v1,kilo.agentSession=agent_xyz,k2=v2\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([
      { containerId: 'c', agentSessionId: 'agent_xyz', port: 5050 },
    ]);
  });
});

describe('findWrapperContainerForSession', () => {
  it('returns null when no container matches', async () => {
    const sandbox = mockExec(() => ({ exitCode: 0, stdout: '' }));
    expect(await findWrapperContainerForSession(sandbox, 'agent_xyz')).toBeNull();
  });

  it('returns wrapper info when the matching container is alive', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'cont-id\t0.0.0.0:5050->5050/tcp\tkilo.agentSession=agent_xyz\n',
    }));
    const result = await findWrapperContainerForSession(sandbox, 'agent_xyz');
    expect(result).not.toBeNull();
    expect(result?.port).toBe(5050);
    expect(result?.process.id).toBe('cont-id');
    expect(result?.process.command).toContain('--agent-session agent_xyz');
  });

  it('returns null when only a different session has a container', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'cont-id\t0.0.0.0:5050->5050/tcp\tkilo.agentSession=agent_other\n',
    }));
    expect(await findWrapperContainerForSession(sandbox, 'agent_xyz')).toBeNull();
  });
});

describe('stopWrapper', () => {
  it('kills only the inner wrapper process when devcontainer metadata is available', async () => {
    const sandbox = {
      listProcesses: vi.fn(async () => []),
      exec: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/run/user/1000/docker.sock' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout:
            'cont-id\t0.0.0.0:5050->5050/tcp\tkilo.agentSession=agent_xyz,kilo.wrapperPort=5050\n',
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/run/user/1000/docker.sock' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }),
    };

    await stopWrapper(sandbox as never, 'agent_xyz', {
      devcontainer: {
        workspacePath: '/workspace/repo',
        configPath: '.devcontainer/devcontainer.json',
      },
    });

    const command = sandbox.exec.mock.calls[3][0] as string;
    expect(command).toContain('devcontainer exec');
    expect(command).toContain('--workspace-folder');
    expect(command).toContain('/workspace/repo');
    // --config keeps the CLI applying our remoteUser=root override on exec.
    expect(command).toContain("--config '/tmp/devcontainer-override-agent_xyz/devcontainer.json'");
    expect(command).toContain('pkill -f --');
    expect(command).not.toContain('docker kill');
  });

  it('kills the container when devcontainer metadata is unavailable', async () => {
    const sandbox = {
      listProcesses: vi.fn(async () => []),
      exec: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/run/user/1000/docker.sock' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout:
            'cont-id\t0.0.0.0:5050->5050/tcp\tkilo.agentSession=agent_xyz,kilo.wrapperPort=5050\n',
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/run/user/1000/docker.sock' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }),
    };

    await stopWrapper(sandbox as never, 'agent_xyz');

    expect(sandbox.exec.mock.calls[3][0]).toBe("docker kill 'cont-id'");
  });
});

describe('isWrapperLiveInProcessesOrContainers', () => {
  // The Process type from @cloudflare/sandbox has more fields than we exercise
  // here (kill, getLogs, etc.); cast through unknown so the unit test stays
  // focused on the marker-matching logic.
  const baseProc = {
    id: 'p1',
    command: 'kilocode-wrapper --agent-session agent_xyz WRAPPER_PORT=5000',
    status: 'running' as const,
  } as unknown as Parameters<typeof isWrapperLiveInProcessesOrContainers>[0][number];

  it('returns true on a process-list match', () => {
    expect(isWrapperLiveInProcessesOrContainers([baseProc], [], 'agent_xyz')).toBe(true);
  });

  it('returns true on a docker-label match', () => {
    expect(
      isWrapperLiveInProcessesOrContainers(
        [],
        [{ containerId: 'c', agentSessionId: 'agent_xyz', port: 5050 }],
        'agent_xyz'
      )
    ).toBe(true);
  });

  it('returns false when neither has a hit', () => {
    expect(
      isWrapperLiveInProcessesOrContainers(
        [],
        [{ containerId: 'c', agentSessionId: 'agent_other', port: 5050 }],
        'agent_xyz'
      )
    ).toBe(false);
  });
});
