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
  bringUpDevContainer,
  buildRestoreCommand,
  buildOverrideConfig,
  detectDevContainer,
  getDevContainerOverridePath,
  KILO_AGENT_SESSION_LABEL,
  KILO_WRAPPER_PORT_LABEL,
  mergeDevContainerConfig,
  parseDevContainerConfig,
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

describe('bringUpDevContainer', () => {
  it('tears down the container when the tool preflight fails after devcontainer up', async () => {
    const session = mockSessionExec(cmd => {
      if (cmd.includes('if [ -S /var/run/docker.sock ]')) {
        return { exitCode: 0, stdout: '/var/run/docker.sock' };
      }
      if (cmd === 'docker version --format {{.Server.Version}}') {
        return { exitCode: 0, stdout: '27.0.0' };
      }
      if (cmd.includes('__KILO_READ_DEVCONTAINER_EOF__')) {
        return { exitCode: 0, stdout: '{"image":"debian:bookworm"}' };
      }
      if (cmd.startsWith('devcontainer up ')) {
        return {
          exitCode: 0,
          stdout:
            '{"outcome":"success","containerId":"deadbeef","remoteWorkspaceFolder":"/workspaces/repo"}',
        };
      }
      if (cmd.includes('command -v bun')) {
        return { exitCode: 0, stdout: 'MISSING' };
      }
      return { exitCode: 0, stdout: '' };
    });

    await expect(
      bringUpDevContainer(session, {
        workspacePath: '/workspace/repo',
        sessionHome: '/home/agent_xyz',
        agentSessionId: 'agent_xyz',
        wrapperPort: 5050,
        kiloCliVersion: '7.2.52',
        configPath: '.devcontainer/devcontainer.json',
      })
    ).rejects.toThrow('Dev container is missing required tools');

    const commands = (
      session.exec as unknown as { mock: { calls: Array<[string]> } }
    ).mock.calls.map(([cmd]) => cmd);
    expect(commands.some(cmd => cmd.startsWith('devcontainer down '))).toBe(true);
    expect(commands.some(cmd => cmd.startsWith('docker rm -f $(docker ps -aq --filter '))).toBe(
      true
    );
    expect(
      commands.some(cmd =>
        cmd.includes("rm -f '/tmp/devcontainer-override-agent_xyz/devcontainer.json'")
      )
    ).toBe(true);
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
      configPath: '.devcontainer/devcontainer.json',
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
        configPath: '.devcontainer/devcontainer.json',
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

  it('removes host-side initializeCommand while preserving in-container lifecycle hooks', () => {
    const merged = mergeDevContainerConfig(
      {
        image: 'debian:bookworm',
        initializeCommand: 'touch /tmp/outer-host-command',
        postCreateCommand: 'pnpm install',
      },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged).not.toHaveProperty('initializeCommand');
    expect(merged.postCreateCommand).toBe('pnpm install');
  });

  it('drops repo mounts that expose outer DIND Docker sockets', () => {
    const merged = mergeDevContainerConfig(
      {
        image: 'debian:bookworm',
        mounts: [
          'source=/var/run,target=/host-var-run,type=bind',
          'source=/run/user/1000/docker.sock,target=/docker.sock,type=bind',
          'source=/workspace/cache,target=/cache,type=bind',
        ],
      },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged.mounts).toEqual([
      'source=/workspace/cache,target=/cache,type=bind',
      'source=/opt/kilo-cloud,target=/opt/kilo-cloud,type=bind,readonly',
      'source=/home/agent_xyz,target=/home/agent_xyz,type=bind',
    ]);
  });

  it('drops repo workspaceMount that exposes outer DIND Docker sockets', () => {
    const merged = mergeDevContainerConfig(
      {
        image: 'debian:bookworm',
        workspaceMount: 'source=/var/run,target=/workspaces/repo,type=bind',
      },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged).not.toHaveProperty('workspaceMount');
  });

  it('preserves repo workspaceMount that does not expose outer DIND Docker sockets', () => {
    const workspaceMount = 'source=/workspace/repo,target=/workspaces/repo,type=bind';
    const merged = mergeDevContainerConfig(
      {
        image: 'debian:bookworm',
        workspaceMount,
      },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged.workspaceMount).toBe(workspaceMount);
  });

  it('drops repo runArgs that expose outer DIND Docker sockets', () => {
    const merged = mergeDevContainerConfig(
      {
        image: 'debian:bookworm',
        runArgs: [
          '--env',
          'USER_FLAG=1',
          '--mount',
          'type=bind,source=/var/run/docker.sock,target=/docker.sock',
          '--mount=type=bind,src=/run/user/1000/docker.sock,target=/rootless.sock',
          '--volume',
          '/var/run:/host-var-run',
          '--volume=/run/user/1000/docker.sock:/rootless.sock',
          '-v',
          '/workspace/cache:/cache',
          '--security-opt',
          'label=disable',
        ],
      },
      { sessionHome: '/home/agent_xyz', wrapperPort: 5050, agentSessionId: 'agent_xyz' }
    );

    expect(merged.runArgs).toEqual([
      '--env',
      'USER_FLAG=1',
      '-v',
      '/workspace/cache:/cache',
      '--security-opt',
      'label=disable',
      '--network=host',
      '--publish',
      '127.0.0.1:5050:5050',
      '--label',
      `${KILO_AGENT_SESSION_LABEL}=agent_xyz`,
      '--label',
      `${KILO_WRAPPER_PORT_LABEL}=5050`,
    ]);
  });

  it('absolutizes relative Docker paths when the override is written outside the config directory', () => {
    const merged = mergeDevContainerConfig(
      {
        dockerComposeFile: ['../compose.yaml', '/shared/compose.yaml'],
        dockerFile: 'Dockerfile.legacy',
        context: '..',
        build: {
          dockerfile: 'Dockerfile',
          context: '..',
        },
      },
      {
        sessionHome: '/home/agent_xyz',
        wrapperPort: 5050,
        agentSessionId: 'agent_xyz',
        relativePathBase: '/workspace/repo/.devcontainer/python',
      }
    );

    expect(merged.dockerComposeFile).toEqual([
      '/workspace/repo/.devcontainer/compose.yaml',
      '/shared/compose.yaml',
    ]);
    expect(merged.dockerFile).toBe('/workspace/repo/.devcontainer/python/Dockerfile.legacy');
    expect(merged.context).toBe('/workspace/repo/.devcontainer');
    expect(merged.build).toMatchObject({
      dockerfile: '/workspace/repo/.devcontainer/python/Dockerfile',
      context: '/workspace/repo/.devcontainer',
    });
  });
});

describe('parseDevContainerConfig', () => {
  it('accepts JSONC comments and trailing commas', () => {
    expect(
      parseDevContainerConfig(`{
        // common in devcontainer.json
        "image": "debian:bookworm",
        "features": {
          "ghcr.io/devcontainers/features/node:1": {},
        },
      }`)
    ).toEqual({
      image: 'debian:bookworm',
      features: {
        'ghcr.io/devcontainers/features/node:1': {},
      },
    });
  });

  it('rejects non-object configs', () => {
    expect(() => parseDevContainerConfig('[]')).toThrow('root value must be an object');
  });
});

describe('buildRestoreCommand', () => {
  it('wraps restore in devcontainer exec with the override config and non-secret runtime env', () => {
    const command = buildRestoreCommand({
      kiloSessionId: 'ses_123',
      runtimeWorkspacePath: '/workspaces/repo',
      runtimeEnv: {
        KILOCODE_TOKEN_FILE: '/home/agent_xyz/.local/share/kilo/session-restore-token',
        KILO_SESSION_INGEST_URL: 'https://ingest.example',
      },
      devContainer: {
        containerId: 'cont-id',
        innerWorkspaceFolder: '/workspaces/repo',
        workspacePath: '/workspace/repo',
        agentSessionId: 'agent_xyz',
        overrideConfigPath: '/tmp/devcontainer-override-agent_xyz/devcontainer.json',
        teardown: vi.fn(),
      },
    });

    expect(command).toContain('devcontainer exec');
    expect(command).toContain("--config '/tmp/devcontainer-override-agent_xyz/devcontainer.json'");
    expect(command).not.toContain('KILOCODE_TOKEN=');
    expect(command).toContain('KILOCODE_TOKEN_FILE=');
    expect(command).toContain('/home/agent_xyz/.local/share/kilo/session-restore-token');
    expect(command).toContain('KILO_SESSION_INGEST_URL=');
    expect(command).toContain('https://ingest.example');
    expect(command).toContain('/opt/kilo-cloud/kilo-restore-session.js');
    expect(command).toContain('/workspaces/repo');
  });

  it('omits runtime env entries whose names are invalid shell variables', () => {
    const command = buildRestoreCommand({
      kiloSessionId: 'ses_123',
      runtimeWorkspacePath: '/workspace/repo',
      runtimeEnv: {
        SAFE_ENV: 'safe-value',
        'X; touch /tmp/pwned #': 'unsafe-value',
      },
      devContainer: undefined,
    });

    expect(command).toContain("SAFE_ENV='safe-value'");
    expect(command).not.toContain('touch /tmp/pwned');
    expect(command).not.toContain('X;');
  });
});

describe('getDevContainerOverridePath', () => {
  it('falls back to the legacy deterministic temp path without config metadata', () => {
    expect(getDevContainerOverridePath('agent_xyz')).toBe(
      '/tmp/devcontainer-override-agent_xyz/devcontainer.json'
    );
  });

  it('uses an accepted devcontainer.json basename when config metadata is available', () => {
    expect(
      getDevContainerOverridePath(
        'agent_xyz',
        '/workspace/repo',
        '.devcontainer/python/devcontainer.json'
      )
    ).toBe('/tmp/devcontainer-override-agent_xyz/devcontainer.json');
  });
});
