import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopOwnedSandboxFamily } from '../../e2e/lifecycle.js';
import {
  computeExclusiveLayout,
  inspectControlPlaneHistory,
  inspectControlPlaneWorkspaceFile,
  stopOwnedControlPlaneSandbox,
  type ControlPlaneKiloRuntime,
  type DockerCommandExecutor,
  type SandboxContainer,
} from '../../e2e/sandbox-control.js';

const KILO_SESSION_ID = 'ses_owned';
const WORKSPACE_SESSION_ID = 'workspace_owned';

const ownedPrimary: SandboxContainer = {
  id: 'owned-primary-id',
  name: 'cloud-agent-next-dev-Sandbox-owned',
  image: 'cloudflare/sandbox:latest',
  isProxy: false,
};

const ownedProxy: SandboxContainer = {
  id: 'owned-proxy-id',
  name: `${ownedPrimary.name}-proxy`,
  image: 'cloudflare/sandbox:latest',
  isProxy: true,
};

const unrelatedPrimary: SandboxContainer = {
  id: 'unrelated-primary-id',
  name: 'cloud-agent-next-dev-Sandbox-unrelated',
  image: 'cloudflare/sandbox:latest',
  isProxy: false,
};

const runtime: ControlPlaneKiloRuntime = {
  container: ownedPrimary,
  kiloSessionId: KILO_SESSION_ID,
  serverUrl: 'http://127.0.0.1:4096',
  directory: '/worktrees/owned',
  home: '/home/owned',
  processId: 42,
};

const validDiscovery = {
  ok: true,
  matched: true,
  kiloSessionId: KILO_SESSION_ID,
  serverUrl: runtime.serverUrl,
  directory: runtime.directory,
  home: runtime.home,
  processId: runtime.processId,
};

const CONTAINER_GONE_MESSAGE = `Error response from daemon: container ${ownedPrimary.id} is not running`;
// Mid-exec death can surface as a bare nonzero exit with none of the Docker
// "gone" fragments, so callers must recheck the exact container instead of
// matching the message.
const OPAQUE_EXEC_FAILURE = `Command failed: docker exec ${ownedPrimary.id} bun -e <script>`;

function dockerPsOutput(containers: SandboxContainer[]): string {
  return containers
    .map(container => `${container.id}\t${container.name}\t${container.image}`)
    .join('\n');
}

function execOperation(args: string[]): Record<string, unknown> {
  const operation = args.at(-1);
  if (operation === undefined) throw new Error('docker exec call had no operation');
  return JSON.parse(operation) as Record<string, unknown>;
}

/**
 * `psSequence` is consumed one entry per `docker ps` call (the last entry
 * repeats), which lets a test describe a container that is running for the
 * proof and then absent for the recheck. `exec` may throw to simulate an exec
 * failure; a thrown error is not treated as a gone container any more than a
 * real exit code is.
 */
function createExecutor(options: {
  containers?: SandboxContainer[];
  psSequence?: SandboxContainer[][];
  exec?: (operation: Record<string, unknown>, containerId: string) => unknown;
  execError?: Error;
  onKill?: (containerId: string) => void;
}): DockerCommandExecutor {
  let psCalls = 0;
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'ps') {
      const list = options.psSequence
        ? (options.psSequence[Math.min(psCalls, options.psSequence.length - 1)] ?? [])
        : (options.containers ?? []);
      psCalls += 1;
      return { stdout: dockerPsOutput(list) };
    }
    if (args[0] === 'kill') {
      options.onKill?.(args[1] ?? '');
      return { stdout: args[1] ?? '' };
    }
    if (args[0] === 'exec') {
      if (options.execError !== undefined) throw options.execError;
      return {
        stdout: JSON.stringify(options.exec?.(execOperation(args), args[1] ?? '') ?? { ok: true }),
      };
    }
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stopOwnedControlPlaneSandbox best-effort cleanup', () => {
  it('returns [] without killing when the named container is already gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kill = vi.fn();
    const executeDocker = createExecutor({ containers: [unrelatedPrimary], onKill: kill });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).resolves.toEqual([]);

    expect(kill).not.toHaveBeenCalled();
    expect(executeDocker).not.toHaveBeenCalledWith(expect.arrayContaining(['kill']));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is already gone'));
  });

  it('still throws when the container runs but its root cannot be proven', async () => {
    const kill = vi.fn();
    const executeDocker = createExecutor({
      containers: [ownedPrimary],
      exec: () => ({ ok: true, matched: false }),
      onKill: kill,
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).rejects.toThrow('Cannot prove the original sandbox still owns the requested root');
    expect(kill).not.toHaveBeenCalled();
  });

  it('still throws when the container runs but exclusive ownership fails', async () => {
    const kill = vi.fn();
    const executeDocker = createExecutor({
      containers: [ownedPrimary],
      exec: operation =>
        operation.action === 'discover' ? validDiscovery : { ok: true, exclusive: false },
      onKill: kill,
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).rejects.toThrow('Refusing cleanup of a sandbox with other worktrees');
    expect(kill).not.toHaveBeenCalled();
  });

  it('rejects when exclusive reports gone but the container is running again at the recheck', async () => {
    const kill = vi.fn();
    const executeDocker = createExecutor({
      psSequence: [[ownedPrimary]],
      exec: operation => {
        if (operation.action === 'discover') return validDiscovery;
        throw new Error(CONTAINER_GONE_MESSAGE);
      },
      onKill: kill,
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).rejects.toThrow('Cannot prove exclusive ownership of owned-primary-id');
    expect(kill).not.toHaveBeenCalled();
  });

  it('returns [] when discovery fails without a gone marker and the container is confirmed absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kill = vi.fn();
    const executeDocker = createExecutor({
      psSequence: [[ownedPrimary], [ownedPrimary], []],
      exec: () => {
        throw new Error(OPAQUE_EXEC_FAILURE);
      },
      onKill: kill,
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills the family when ownership is proven exclusive', async () => {
    const killedIds: string[] = [];
    const executeDocker = createExecutor({
      containers: [ownedPrimary, ownedProxy, unrelatedPrimary],
      exec: (operation, containerId) => {
        if (operation.action === 'discover') {
          return containerId === ownedPrimary.id ? validDiscovery : { ok: true, matched: false };
        }
        return { ok: true, exclusive: true };
      },
      onKill: containerId => killedIds.push(containerId),
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).resolves.toEqual([ownedPrimary.name, ownedProxy.name]);
    expect(killedIds).toEqual([ownedPrimary.id, ownedProxy.id]);
  });

  it('forwards scenario-owned allowed directories into the exclusive proof', async () => {
    const killedIds: string[] = [];
    const operations: Record<string, unknown>[] = [];
    const executeDocker = createExecutor({
      containers: [ownedPrimary],
      exec: operation => {
        operations.push(operation);
        if (operation.action === 'discover') return validDiscovery;
        return { ok: true, exclusive: true };
      },
      onKill: containerId => killedIds.push(containerId),
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker, [
        '/worktrees/retired',
      ])
    ).resolves.toEqual([ownedPrimary.name]);

    const exclusive = operations.find(operation => operation.action === 'exclusive');
    expect(exclusive).toMatchObject({ allowedDirectories: ['/worktrees/retired'] });
    expect(killedIds).toEqual([ownedPrimary.id]);
  });

  it('treats a container that vanishes during the proof as already gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executeDocker = createExecutor({
      psSequence: [[ownedPrimary], [ownedPrimary], []],
      execError: new Error(CONTAINER_GONE_MESSAGE),
    });

    await expect(
      stopOwnedControlPlaneSandbox(ownedPrimary, KILO_SESSION_ID, executeDocker)
    ).resolves.toEqual([]);
    expect(executeDocker).not.toHaveBeenCalledWith(expect.arrayContaining(['kill']));
  });
});

describe('stopOwnedSandboxFamily coordinator wrapper', () => {
  it('propagates a running-container ownership failure when the family never goes away', async () => {
    const kill = vi.fn();
    const executeDocker = createExecutor({
      psSequence: [[ownedPrimary]],
      exec: operation => {
        if (operation.action === 'discover') return validDiscovery;
        throw new Error(CONTAINER_GONE_MESSAGE);
      },
      onKill: kill,
    });

    await expect(
      stopOwnedSandboxFamily(ownedPrimary, WORKSPACE_SESSION_ID, KILO_SESSION_ID, {
        executeDocker,
        familyGoneTimeoutMs: 0,
      })
    ).rejects.toThrow('Cannot prove exclusive ownership of owned-primary-id');
    expect(kill).not.toHaveBeenCalled();
  });

  it('returns [] when the coordinator proof vanished and the family is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executeDocker = createExecutor({
      psSequence: [[ownedPrimary], [ownedPrimary], [ownedPrimary], [ownedPrimary], []],
      exec: operation => {
        if (operation.action === 'discover') return validDiscovery;
        throw new Error(CONTAINER_GONE_MESSAGE);
      },
    });

    await expect(
      stopOwnedSandboxFamily(ownedPrimary, WORKSPACE_SESSION_ID, KILO_SESSION_ID, { executeDocker })
    ).resolves.toEqual([]);
  });
});

describe('control-plane inspection when the container is gone', () => {
  it('returns an unavailable workspace-file result instead of an opaque docker error', async () => {
    const executeDocker = createExecutor({
      containers: [],
      execError: new Error(CONTAINER_GONE_MESSAGE),
    });

    const file = await inspectControlPlaneWorkspaceFile(
      runtime,
      { kiloSessionId: KILO_SESSION_ID, filePath: 'sentinel.txt' },
      executeDocker
    );

    if (!file.unavailable) throw new Error('expected an unavailable workspace-file inspection');
    expect(file.reason).toContain('container is gone');
  });

  it('returns an unavailable history result instead of an opaque docker error', async () => {
    const executeDocker = createExecutor({
      containers: [],
      execError: new Error(CONTAINER_GONE_MESSAGE),
    });

    const history = await inspectControlPlaneHistory(
      runtime,
      { kiloSessionId: KILO_SESSION_ID, userMessageId: 'msg_1', assistantMarker: 'done' },
      executeDocker
    );

    if (!history.unavailable) throw new Error('expected an unavailable history inspection');
    expect(history.reason).toContain('container is gone');
  });

  it('returns unavailable when a mid-exec death carries no gone marker but the container is absent', async () => {
    const executeDocker = createExecutor({
      psSequence: [[]],
      execError: new Error(OPAQUE_EXEC_FAILURE),
    });

    const file = await inspectControlPlaneWorkspaceFile(
      runtime,
      { kiloSessionId: KILO_SESSION_ID, filePath: 'sentinel.txt' },
      executeDocker
    );

    if (!file.unavailable) throw new Error('expected an unavailable workspace-file inspection');
    expect(file.reason).toContain('container is gone');
  });

  it('does not treat an unrelated inspection failure as an unavailable container', async () => {
    const executeDocker = createExecutor({
      containers: [ownedPrimary],
      execError: new Error('Kilo file returned HTTP 500'),
    });

    await expect(
      inspectControlPlaneWorkspaceFile(
        runtime,
        { kiloSessionId: KILO_SESSION_ID, filePath: 'sentinel.txt' },
        executeDocker
      )
    ).rejects.toThrow('Kilo file returned HTTP 500');
  });
});

/** Build `computeExclusiveLayout` input from a directory, its siblings, and listeners. */
function exclusiveLayoutInput(input: {
  directory: string;
  allowedDirectories?: string[];
  siblings?: string[];
  listeners?: string[];
}) {
  const parent = path.posix.dirname(input.directory);
  const siblings = input.siblings ?? [path.posix.basename(input.directory)];
  const directories = new Set(siblings.map(name => path.posix.join(parent, name)));
  return {
    directory: input.directory,
    ...(input.allowedDirectories !== undefined
      ? { allowedDirectories: input.allowedDirectories }
      : {}),
    path: path.posix,
    fs: {
      readdirSync: () => siblings,
      statSync: (filePath: string) => ({ isDirectory: () => directories.has(filePath) }),
    },
    listeners: (input.listeners ?? [input.directory]).map(directory => ({ directory })),
  };
}

describe('computeExclusiveLayout directory guard', () => {
  it('accepts the worktrees layout when the target is the only directory', () => {
    expect(
      computeExclusiveLayout(
        exclusiveLayoutInput({ directory: '/workspace/user/worktrees/worktree_1' })
      )
    ).toEqual({
      exclusive: true,
      directories: ['/workspace/user/worktrees/worktree_1'],
    });
  });

  it('accepts the sessions layout when the target is the only directory', () => {
    expect(
      computeExclusiveLayout(
        exclusiveLayoutInput({ directory: '/workspace/user/sessions/workspace_1' })
      ).exclusive
    ).toBe(true);
  });

  it('accepts a scenario-owned sibling directory listed in allowedDirectories', () => {
    const result = computeExclusiveLayout(
      exclusiveLayoutInput({
        directory: '/workspace/user/sessions/workspace_1',
        siblings: ['workspace_0', 'workspace_1'],
        allowedDirectories: ['/workspace/user/sessions/workspace_0'],
      })
    );
    expect(result.exclusive).toBe(true);
    expect(result.directories).toEqual([
      '/workspace/user/sessions/workspace_0',
      '/workspace/user/sessions/workspace_1',
    ]);
  });

  it('refuses an unknown sibling directory', () => {
    expect(
      computeExclusiveLayout(
        exclusiveLayoutInput({
          directory: '/workspace/user/sessions/workspace_1',
          siblings: ['workspace_0', 'workspace_1'],
        })
      ).exclusive
    ).toBe(false);
  });

  it('refuses a foreign Kilo listener outside the allowed set', () => {
    expect(
      computeExclusiveLayout(
        exclusiveLayoutInput({
          directory: '/workspace/user/sessions/workspace_1',
          listeners: ['/workspace/user/sessions/workspace_2'],
        })
      ).exclusive
    ).toBe(false);
  });

  it('refuses a parent that is neither sessions nor worktrees', () => {
    expect(
      computeExclusiveLayout(exclusiveLayoutInput({ directory: '/tmp/owned' })).exclusive
    ).toBe(false);
  });

  it('refuses when the target directory itself is absent', () => {
    expect(
      computeExclusiveLayout(
        exclusiveLayoutInput({
          directory: '/workspace/user/sessions/workspace_1',
          siblings: ['workspace_2'],
        })
      ).exclusive
    ).toBe(false);
  });
});
