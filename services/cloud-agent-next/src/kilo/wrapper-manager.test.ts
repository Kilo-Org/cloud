import { describe, expect, it, vi } from 'vitest';
import {
  discoverSessionWrappers,
  extractPublishedWrapperPort,
  findWrapperContainerForSession,
  isWrapperLiveInProcessesOrContainers,
  listWrapperContainers,
  stopObservedWrappers,
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

  it('retains labelled rows with no published port for lifecycle observation', async () => {
    const sandbox = mockExec(() => ({
      exitCode: 0,
      stdout: 'cont-2\t\tkilo.agentSession=agent_abc\n',
    }));
    expect(await listWrapperContainers(sandbox)).toEqual([
      { containerId: 'cont-2', agentSessionId: 'agent_abc' },
    ]);
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

describe('discoverSessionWrappers', () => {
  it('returns every direct and devcontainer wrapper process tagged for the session', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'direct-one',
          command:
            'WRAPPER_PORT=5010 kilocode-wrapper --agent-session agent_xyz --wrapper-instance-id instance_direct --wrapper-instance-generation 4',
          status: 'running',
        },
        {
          id: 'direct-two',
          command: 'WRAPPER_PORT=5011 kilocode-wrapper --agent-session agent_xyz',
          status: 'starting',
        },
      ]),
      exec: vi.fn().mockImplementation((command: string) => {
        if (command.includes('docker ps')) {
          return Promise.resolve({
            exitCode: 0,
            stdout:
              'cont-id\t0.0.0.0:5050->5050/tcp\tkilo.agentSession=agent_xyz,kilo.wrapperPort=5050\n',
          });
        }
        if (command.includes('/proc/42/environ')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: 'WRAPPER_INSTANCE_ID=instance_container WRAPPER_INSTANCE_GENERATION=7',
          });
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: '42 WRAPPER_PORT=5050 kilocode-wrapper --agent-session agent_xyz\n',
        });
      }),
    };

    await expect(
      discoverSessionWrappers(sandbox as never, 'agent_xyz', { dockerEnv: {} })
    ).resolves.toEqual({
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'direct-one',
          port: 5010,
          instanceId: 'instance_direct',
          instanceGeneration: 4,
        },
        { representation: 'process', id: 'direct-two', port: 5011 },
        {
          representation: 'container',
          id: 'cont-id',
          port: 5050,
          instanceId: 'instance_container',
          instanceGeneration: 7,
        },
      ],
    });
  });

  it('normalizes shell-quoted physical instance markers from wrapper startup', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'quoted-instance',
          command:
            "WRAPPER_PORT=5010 bun run '/usr/local/bin/kilocode-wrapper.js' --agent-session agent_xyz --wrapper-instance-id 'instance_quoted' --wrapper-instance-generation 4",
          status: 'running',
        },
      ]),
      exec: vi.fn(),
    };

    await expect(
      discoverSessionWrappers(sandbox as never, 'agent_xyz', { inspectContainers: false })
    ).resolves.toEqual({
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'quoted-instance',
          port: 5010,
          instanceId: 'instance_quoted',
          instanceGeneration: 4,
        },
      ],
    });
  });

  it('observes backward-compatible environment physical instance markers', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'compat-instance',
          command:
            "WRAPPER_PORT=5010 WRAPPER_INSTANCE_ID='instance_compat' WRAPPER_INSTANCE_GENERATION=5 bun run '/usr/local/bin/kilocode-wrapper.js' --agent-session agent_xyz",
          status: 'running',
        },
      ]),
      exec: vi.fn(),
    };

    await expect(
      discoverSessionWrappers(sandbox as never, 'agent_xyz', { inspectContainers: false })
    ).resolves.toEqual({
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'compat-instance',
          port: 5010,
          instanceId: 'instance_compat',
          instanceGeneration: 5,
        },
      ],
    });
  });

  it('reports inspection failure instead of absence when requested Docker inspection fails', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([]),
      exec: vi.fn().mockRejectedValue(new Error('docker unavailable')),
    };

    await expect(
      discoverSessionWrappers(sandbox as never, 'agent_xyz', { dockerEnv: {} })
    ).resolves.toMatchObject({
      status: 'inspection-failed',
      error: expect.stringContaining('docker unavailable'),
    });
  });

  it('does not require Docker inspection for a standard-sandbox lifecycle query', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([]),
      exec: vi.fn().mockRejectedValue(new Error('docker unavailable')),
    };

    await expect(
      discoverSessionWrappers(sandbox as never, 'agent_xyz', { inspectContainers: false })
    ).resolves.toEqual({ status: 'absent' });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('observes a direct physical wrapper even when it has no HTTP port yet', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'direct-starting',
          command:
            'kilocode-wrapper --agent-session agent_xyz --wrapper-instance-id instance_starting --wrapper-instance-generation 8',
          status: 'starting',
        },
      ]),
      exec: vi.fn(),
    };

    await expect(
      discoverSessionWrappers(sandbox as never, 'agent_xyz', { inspectContainers: false })
    ).resolves.toEqual({
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'direct-starting',
          instanceId: 'instance_starting',
          instanceGeneration: 8,
        },
      ],
    });
  });

  it('stops an environment-tagged direct wrapper by its logical session marker', async () => {
    const sandbox = { exec: vi.fn().mockResolvedValue({ exitCode: 0 }) };

    await stopObservedWrappers(sandbox as never, 'agent_xyz', [
      {
        representation: 'process',
        id: 'direct-one',
        port: 5010,
        instanceId: 'instance_direct',
        instanceGeneration: 4,
      },
    ]);

    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining('--agent-session agent_xyz'));
    expect(sandbox.exec).not.toHaveBeenCalledWith(expect.stringContaining('WRAPPER_INSTANCE_ID'));
  });

  it('force stops a leased devcontainer wrapper process without destroying its persistent container', async () => {
    const sandbox = {
      exec: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '/run/user/1000/docker.sock' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' }),
    };

    await stopObservedWrappers(
      sandbox as never,
      'agent_xyz',
      [
        {
          representation: 'container',
          id: 'persistent-container',
          port: 5050,
          instanceId: 'instance_container',
          instanceGeneration: 7,
        },
      ],
      {
        force: true,
        devcontainer: {
          workspacePath: '/workspace/repo',
          configPath: '.devcontainer/devcontainer.json',
        },
      }
    );

    const command = sandbox.exec.mock.calls[1][0] as string;
    expect(command).toContain('docker exec');
    expect(command).toContain('pkill -9 -f --');
    expect(command).toContain('--agent-session agent_xyz');
    expect(command).not.toContain('WRAPPER_INSTANCE_ID');
    expect(command).not.toContain('docker kill');
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

  it('protects a live direct wrapper workspace even before its port is available', () => {
    const startingWithoutPort = {
      id: 'p-starting',
      command: 'kilocode-wrapper --agent-session agent_xyz',
      status: 'starting' as const,
    } as unknown as Parameters<typeof isWrapperLiveInProcessesOrContainers>[0][number];

    expect(isWrapperLiveInProcessesOrContainers([startingWithoutPort], [], 'agent_xyz')).toBe(true);
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
