import { describe, expect, it, vi } from 'vitest';
import {
  buildKiloSessionXdgEnv,
  dockerSocketEnv,
  dockerSocketEnvParts,
  resolveDockerSocketPath,
} from './sandbox-runtime.js';
import type { ExecutionSession } from '../types.js';

const mockExec = (impl: (cmd: string) => { exitCode: number; stdout?: string }) =>
  ({
    exec: vi.fn(async (cmd: string) => impl(cmd)),
  }) as unknown as ExecutionSession;

describe('resolveDockerSocketPath', () => {
  it('returns the detected Docker socket path', async () => {
    const session = mockExec(cmd => {
      expect(cmd).toContain('/var/run/docker.sock');
      return { exitCode: 0, stdout: '/var/run/docker.sock' };
    });
    expect(await resolveDockerSocketPath(session)).toBe('/var/run/docker.sock');
  });

  it('handles rootless socket paths', async () => {
    const session = mockExec(() => ({ exitCode: 0, stdout: '/run/user/1000/docker.sock' }));
    expect(await resolveDockerSocketPath(session)).toBe('/run/user/1000/docker.sock');
  });

  it('falls back to /var/run/docker.sock on a non-zero exit code', async () => {
    const session = mockExec(() => ({ exitCode: 1, stdout: '' }));
    expect(await resolveDockerSocketPath(session)).toBe('/var/run/docker.sock');
  });

  it('falls back to /var/run/docker.sock on empty output', async () => {
    const session = mockExec(() => ({ exitCode: 0, stdout: '' }));
    expect(await resolveDockerSocketPath(session)).toBe('/var/run/docker.sock');
  });

  it('falls back to /var/run/docker.sock when exec throws', async () => {
    const session = {
      exec: vi.fn(() => Promise.reject(new Error('sandbox unreachable'))),
    } as unknown as ExecutionSession;
    expect(await resolveDockerSocketPath(session)).toBe('/var/run/docker.sock');
  });

  it('shells out on every call (no cross-call memoisation)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '/var/run/docker.sock' }));
    const session = { exec } as unknown as ExecutionSession;
    await resolveDockerSocketPath(session);
    await resolveDockerSocketPath(session);
    await resolveDockerSocketPath(session);
    expect(exec).toHaveBeenCalledTimes(3);
  });
});

describe('dockerSocketEnvParts', () => {
  it('emits DOCKER_HOST for the given socket path', () => {
    expect(dockerSocketEnvParts('/var/run/docker.sock')).toEqual([
      'DOCKER_HOST=unix:///var/run/docker.sock',
    ]);
  });

  it('parameterises the socket path', () => {
    expect(dockerSocketEnvParts('/run/user/1000/docker.sock')).toEqual([
      'DOCKER_HOST=unix:///run/user/1000/docker.sock',
    ]);
  });
});

describe('dockerSocketEnv', () => {
  it('returns a record with DOCKER_HOST for the given socket path', () => {
    expect(dockerSocketEnv('/var/run/docker.sock')).toEqual({
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    });
  });

  it('parameterises the socket path', () => {
    expect(dockerSocketEnv('/run/user/1000/docker.sock')).toEqual({
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    });
  });
});

describe('buildKiloSessionXdgEnv', () => {
  it('roots Kilo XDG directories under the session home', () => {
    expect(buildKiloSessionXdgEnv('/home/agent_xyz')).toEqual({
      XDG_DATA_HOME: '/home/agent_xyz/.local/share',
      XDG_CONFIG_HOME: '/home/agent_xyz/.config',
      XDG_CACHE_HOME: '/home/agent_xyz/.cache',
    });
  });
});
