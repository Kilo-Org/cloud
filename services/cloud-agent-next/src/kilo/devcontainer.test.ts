/**
 * Unit tests for the dev container module.
 *
 * The orchestration helpers (`bringUpDevContainer`, `teardownDevContainer`)
 * shell out via `session.exec`, so tests cover the surfaces that don't need a
 * real container:
 *   - detection of `.devcontainer/...` configs
 *   - `devcontainer up --log-format json` outcome parsing
 *   - generated override shape and merge behavior
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildOverrideConfig,
  detectDevContainer,
  getDevContainerOverridePath,
  KILO_AGENT_SESSION_LABEL,
  KILO_WRAPPER_PORT_LABEL,
  mergeDevContainerConfig,
  parseUpOutcome,
  writeMergedOverrideConfig,
} from './devcontainer.js';
import type { ExecutionSession } from '../types.js';

const mockSessionExec = (impl: (cmd: string) => { exitCode: number; stdout?: string }) =>
  ({
    exec: vi.fn(async (cmd: string) => impl(cmd)),
  }) as unknown as ExecutionSession;

describe('detectDevContainer', () => {
  it('returns null when no devcontainer file exists', async () => {
    const session = mockSessionExec(() => ({ exitCode: 0, stdout: '' }));
    const result = await detectDevContainer(session, '/workspace/repo');
    expect(result).toBeNull();
  });

  it('returns the canonical .devcontainer/devcontainer.json when present', async () => {
    const session = mockSessionExec(cmd => {
      // The shell script echoes the first matching path; here we simulate the
      // canonical hit by returning that line.
      expect(cmd).toContain('cd ');
      expect(cmd).toContain('/workspace/repo');
      return { exitCode: 0, stdout: '.devcontainer/devcontainer.json\n' };
    });
    const result = await detectDevContainer(session, '/workspace/repo');
    expect(result).toEqual({ configPath: '.devcontainer/devcontainer.json' });
  });

  it('falls back to a sub-folder devcontainer.json', async () => {
    const session = mockSessionExec(() => ({
      exitCode: 0,
      stdout: '.devcontainer/python/devcontainer.json\n',
    }));
    const result = await detectDevContainer(session, '/workspace/repo');
    expect(result).toEqual({ configPath: '.devcontainer/python/devcontainer.json' });
  });

  it('returns null when the session exec fails', async () => {
    const session = mockSessionExec(() => ({ exitCode: 1 }));
    expect(await detectDevContainer(session, '/workspace/repo')).toBeNull();
  });

  it('shell-quotes the workspace path', async () => {
    const session = mockSessionExec(() => ({ exitCode: 0, stdout: '' }));
    await detectDevContainer(session, "/work's space/repo");
    const calls = (session.exec as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // Should escape the embedded single quote.
    expect(calls[0][0]).toContain(`/work'\\''s space/repo`);
  });
});

describe('parseUpOutcome', () => {
  it('returns null on empty stdout', () => {
    expect(parseUpOutcome('')).toBeNull();
  });

  it('extracts containerId and remoteWorkspaceFolder from a success line', () => {
    const stdout = [
      '{"type":"progress","step":"build"}',
      '{"outcome":"success","containerId":"deadbeef","remoteWorkspaceFolder":"/workspaces/repo"}',
    ].join('\n');
    expect(parseUpOutcome(stdout)).toEqual({
      containerId: 'deadbeef',
      remoteWorkspaceFolder: '/workspaces/repo',
    });
  });

  it('ignores non-success outcomes and non-JSON lines', () => {
    const stdout = [
      'plain log line — not JSON',
      '{"outcome":"error","message":"build failed"}',
      'still plain text',
    ].join('\n');
    expect(parseUpOutcome(stdout)).toBeNull();
  });

  it('prefers the last success line if multiple are emitted', () => {
    const stdout = [
      '{"outcome":"success","containerId":"first","remoteWorkspaceFolder":"/old"}',
      '{"outcome":"success","containerId":"second","remoteWorkspaceFolder":"/new"}',
    ].join('\n');
    expect(parseUpOutcome(stdout)).toEqual({
      containerId: 'second',
      remoteWorkspaceFolder: '/new',
    });
  });

  it('returns null when success line is missing required fields', () => {
    const stdout = '{"outcome":"success"}';
    expect(parseUpOutcome(stdout)).toBeNull();
  });
});

describe('buildOverrideConfig', () => {
  const baseOpts = {
    sessionHome: '/home/agent_xyz',
    wrapperPort: 5050,
    agentSessionId: 'agent_xyz',
  };

  it('does not override workspaceMount or workspaceFolder', () => {
    const cfg = buildOverrideConfig(baseOpts);
    expect(cfg).not.toHaveProperty('workspaceMount');
    expect(cfg).not.toHaveProperty('workspaceFolder');
  });

  it('includes the required mounts without exposing Docker', () => {
    const cfg = buildOverrideConfig(baseOpts);
    expect(cfg.mounts).toEqual([
      'source=/opt/kilo-cloud,target=/opt/kilo-cloud,type=bind,readonly',
      'source=/home/agent_xyz,target=/home/agent_xyz,type=bind',
    ]);
  });

  it('publishes the wrapper port to outer loopback and stamps the agent-session label', () => {
    const cfg = buildOverrideConfig(baseOpts);
    expect(cfg.runArgs).toEqual([
      '--network=host',
      '--publish',
      '127.0.0.1:5050:5050',
      '--label',
      `${KILO_AGENT_SESSION_LABEL}=agent_xyz`,
      '--label',
      `${KILO_WRAPPER_PORT_LABEL}=5050`,
    ]);
  });

  it('sets HOME without exposing the outer Docker socket', () => {
    const cfg = buildOverrideConfig(baseOpts);
    expect(cfg.remoteEnv).toEqual({
      HOME: '/home/agent_xyz',
      KILO_CLOUD_AGENT: '1',
    });
  });

  it('forces remoteUser to root so bind-mount ownership lines up without uid rewrites', () => {
    const cfg = buildOverrideConfig(baseOpts);
    expect(cfg.remoteUser).toBe('root');
  });
});

describe('writeMergedOverrideConfig', () => {
  it('writes a node script that merges additive Kilo config into the user config', async () => {
    const session = mockSessionExec(cmd => {
      expect(cmd).toContain('const outputPath = "/tmp/merged-devcontainer.json"');
      expect(cmd).toContain('source=/opt/kilo-cloud,target=/opt/kilo-cloud,type=bind,readonly');
      expect(cmd).toContain('source=/home/agent_xyz,target=/home/agent_xyz,type=bind');
      expect(cmd).toContain(`${KILO_AGENT_SESSION_LABEL}=agent_xyz`);
      expect(cmd).toContain(`${KILO_WRAPPER_PORT_LABEL}=5050`);
      return { exitCode: 0 };
    });

    await writeMergedOverrideConfig(session, {
      workspacePath: '/workspace/repo',
      outputPath: '/tmp/merged-devcontainer.json',
      baseConfig: { image: 'debian:bookworm', remoteUser: 'vscode' },
      sessionHome: '/home/agent_xyz',
      wrapperPort: 5050,
      agentSessionId: 'agent_xyz',
    });
  });

  it('throws when the merge script fails', async () => {
    const session = mockSessionExec(() => ({ exitCode: 1, stderr: 'bad json' }));

    await expect(
      writeMergedOverrideConfig(session, {
        workspacePath: '/workspace/repo',
        outputPath: '/tmp/merged-devcontainer.json',
        baseConfig: { image: 'debian:bookworm' },
        sessionHome: '/home/agent_xyz',
        wrapperPort: 5050,
        agentSessionId: 'agent_xyz',
      })
    ).rejects.toThrow('bad json');
  });
});

describe('mergeDevContainerConfig', () => {
  it('preserves user config while appending Kilo mounts, runArgs, and remoteEnv', () => {
    const merged = mergeDevContainerConfig(
      {
        image: 'debian:bookworm',
        mounts: ['source=/user,target=/user,type=bind'],
        runArgs: ['--env', 'USER_FLAG=1'],
        remoteEnv: { USER_ENV: '1' },
      },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged.image).toBe('debian:bookworm');
    expect(merged.mounts).toEqual([
      'source=/user,target=/user,type=bind',
      'source=/opt/kilo-cloud,target=/opt/kilo-cloud,type=bind,readonly',
      'source=/home/agent_xyz,target=/home/agent_xyz,type=bind',
    ]);
    expect(merged.runArgs).toEqual([
      '--env',
      'USER_FLAG=1',
      '--network=host',
      '--publish',
      '127.0.0.1:5050:5050',
      '--label',
      `${KILO_AGENT_SESSION_LABEL}=agent_xyz`,
      '--label',
      `${KILO_WRAPPER_PORT_LABEL}=5050`,
    ]);
    expect(merged.remoteEnv).toEqual({
      USER_ENV: '1',
      HOME: '/home/agent_xyz',
      KILO_CLOUD_AGENT: '1',
    });
  });

  it("overrides the user's remoteUser with root", () => {
    const merged = mergeDevContainerConfig(
      { image: 'debian:bookworm', remoteUser: 'vscode' },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged.remoteUser).toBe('root');
  });
});

describe('getDevContainerOverridePath', () => {
  it('is deterministic given an agent session ID so any subsystem can pass --config', () => {
    expect(getDevContainerOverridePath('agent_xyz')).toBe(
      '/tmp/devcontainer-override-agent_xyz/devcontainer.json'
    );
  });
});
