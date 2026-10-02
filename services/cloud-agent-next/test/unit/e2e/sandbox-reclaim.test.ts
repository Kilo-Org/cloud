import { afterEach, describe, expect, it, vi } from 'vitest';

import { reclaimOwnedSandboxes } from '../../e2e/lifecycle.js';
import {
  findOrphanProxies,
  type DockerCommandExecutor,
  type SandboxContainer,
} from '../../e2e/sandbox-control.js';

function primary(name: string): SandboxContainer {
  return { id: `${name}-id`, name, image: 'cloudflare/sandbox:latest', isProxy: false };
}

function proxyOf(container: SandboxContainer): SandboxContainer {
  return {
    id: `${container.id}-proxy`,
    name: `${container.name}-proxy`,
    image: container.image,
    isProxy: true,
  };
}

const rootA = primary('cloud-agent-next-dev-Sandbox-a');
const rootB = primary('cloud-agent-next-dev-Sandbox-b');

type Discovery = { kiloSessionId: string; directory: string };

/**
 * A fake Docker that keeps its own container list, so a kill is visible to the
 * next `docker ps` exactly like the real daemon. `discoveries` maps a container
 * id to the Kilo roots it hosts; `exclusive` decides the exclusivity proof.
 */
function createDocker(options: {
  containers: SandboxContainer[];
  discoveries?: Record<string, Discovery[]>;
  exclusive?: (allowedDirectories: string[]) => boolean;
}): {
  execute: DockerCommandExecutor;
  running: () => string[];
  killed: string[];
  exclusiveCalls: Array<{ containerId: string; allowedDirectories: string[] }>;
} {
  let containers = [...options.containers];
  const killed: string[] = [];
  const exclusiveCalls: Array<{ containerId: string; allowedDirectories: string[] }> = [];
  const execute: DockerCommandExecutor = async args => {
    if (args[0] === 'ps') {
      return {
        stdout: containers.map(item => `${item.id}\t${item.name}\t${item.image}`).join('\n'),
      };
    }
    if (args[0] === 'kill') {
      killed.push(args[1] ?? '');
      containers = containers.filter(item => item.id !== args[1]);
      return { stdout: '' };
    }
    if (args[0] === 'exec') {
      const containerId = args[1] ?? '';
      const operation = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
      const hosted = options.discoveries?.[containerId] ?? [];
      if (operation.action === 'discover') {
        const match = hosted.find(item => item.kiloSessionId === operation.kiloSessionId);
        if (!match) return { stdout: JSON.stringify({ ok: true, matched: false }) };
        return {
          stdout: JSON.stringify({
            ok: true,
            matched: true,
            kiloSessionId: match.kiloSessionId,
            serverUrl: 'http://127.0.0.1:4096',
            directory: match.directory,
            home: '/home/kilo',
            processId: 42,
          }),
        };
      }
      const allowedDirectories = (operation.allowedDirectories as string[] | undefined) ?? [];
      exclusiveCalls.push({ containerId, allowedDirectories });
      const exclusive = options.exclusive?.(allowedDirectories) ?? true;
      return { stdout: JSON.stringify({ ok: true, exclusive }) };
    }
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  };
  return { execute, running: () => containers.map(item => item.name), killed, exclusiveCalls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reclaimOwnedSandboxes', () => {
  it('stops the owned sandbox with its proxy and leaves an unrelated sandbox running', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA), rootB, proxyOf(rootB)],
      discoveries: {
        [rootA.id]: [{ kiloSessionId: 'ses_a', directory: '/workspace/u/worktrees/a' }],
        [rootB.id]: [{ kiloSessionId: 'ses_b', directory: '/workspace/u/worktrees/b' }],
      },
    });

    const report = await reclaimOwnedSandboxes(
      [{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }],
      { executeDocker: docker.execute, familyGoneTimeoutMs: 20, retryMs: 1 }
    );

    expect(report).toEqual({ stopped: [rootA.name], failures: [] });
    expect(docker.running()).toEqual([rootB.name, `${rootB.name}-proxy`]);
  });

  it('stops a sandbox shared by two sessions once and allows both worktrees', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA)],
      discoveries: {
        [rootA.id]: [
          { kiloSessionId: 'ses_root', directory: '/workspace/u/worktrees/root' },
          { kiloSessionId: 'ses_sibling', directory: '/workspace/u/worktrees/sibling' },
        ],
      },
      exclusive: allowed =>
        allowed.includes('/workspace/u/worktrees/root') &&
        allowed.includes('/workspace/u/worktrees/sibling'),
    });

    const report = await reclaimOwnedSandboxes(
      [
        { sessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' },
        { sessionId: 'workspace_root', kiloSessionId: 'ses_root' },
      ],
      { executeDocker: docker.execute, familyGoneTimeoutMs: 20, retryMs: 1 }
    );

    expect(report).toEqual({ stopped: [rootA.name], failures: [] });
    expect(docker.running()).toEqual([]);
    expect(docker.exclusiveCalls).toHaveLength(1);
  });

  it('leaves the sandbox running when another worktree still lives in it', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA)],
      discoveries: {
        [rootA.id]: [{ kiloSessionId: 'ses_a', directory: '/workspace/u/worktrees/a' }],
      },
      exclusive: () => false,
    });

    const report = await reclaimOwnedSandboxes(
      [{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }],
      { executeDocker: docker.execute, familyGoneTimeoutMs: 20, retryMs: 1 }
    );

    expect(report.stopped).toEqual([]);
    expect(report.failures).toEqual([
      expect.stringContaining('Refusing cleanup of a sandbox with other worktrees'),
    ]);
    expect(docker.killed).toEqual([]);
  });

  it('never kills for a workspace session that recorded no Kilo session id', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA)],
      discoveries: {
        [rootA.id]: [{ kiloSessionId: 'ses_a', directory: '/workspace/u/worktrees/a' }],
      },
    });

    const report = await reclaimOwnedSandboxes([{ sessionId: 'workspace_a' }], {
      executeDocker: docker.execute,
      retryMs: 1,
    });

    expect(report.stopped).toEqual([]);
    expect(report.failures).toEqual([expect.stringContaining('ownership is unprovable')]);
    expect(docker.killed).toEqual([]);
  });

  it('reports nothing for a session whose sandbox already stopped', async () => {
    const docker = createDocker({ containers: [rootB, proxyOf(rootB)] });

    const report = await reclaimOwnedSandboxes(
      [{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }],
      { executeDocker: docker.execute, familyGoneTimeoutMs: 20, retryMs: 1 }
    );

    expect(report).toEqual({ stopped: [], failures: [] });
    expect(docker.killed).toEqual([]);
  });

  it('retries a locate scan that a sibling scenario killed mid-exec', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA), rootB, proxyOf(rootB)],
      discoveries: {
        [rootA.id]: [{ kiloSessionId: 'ses_a', directory: '/workspace/u/worktrees/a' }],
      },
    });
    let brokenExecs = 1;
    const flaky: DockerCommandExecutor = async args => {
      if (args[0] === 'exec' && args[1] === rootB.id && brokenExecs > 0) {
        brokenExecs -= 1;
        throw new Error(`Command failed: docker exec ${rootB.id} bun -e <script>`);
      }
      return docker.execute(args);
    };

    const report = await reclaimOwnedSandboxes(
      [{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }],
      {
        executeDocker: flaky,
        familyGoneTimeoutMs: 20,
        retryMs: 1,
      }
    );

    expect(report).toEqual({ stopped: [rootA.name], failures: [] });
    expect(docker.running()).toEqual([rootB.name, `${rootB.name}-proxy`]);
  });

  it('retries the stop when a sibling kill breaks the exclusivity scan', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA), rootB, proxyOf(rootB)],
      discoveries: {
        [rootA.id]: [{ kiloSessionId: 'ses_a', directory: '/workspace/u/worktrees/a' }],
      },
    });
    let brokenExclusive = 1;
    const flaky: DockerCommandExecutor = async args => {
      if (args[0] === 'exec') {
        const operation = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
        if (operation.action === 'exclusive' && brokenExclusive > 0) {
          brokenExclusive -= 1;
          throw new Error(`Command failed: docker exec ${args[1]} bun -e <script>`);
        }
      }
      return docker.execute(args);
    };

    const report = await reclaimOwnedSandboxes(
      [{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }],
      { executeDocker: flaky, familyGoneTimeoutMs: 20, retryMs: 1 }
    );

    expect(report).toEqual({ stopped: [rootA.name], failures: [] });
    expect(docker.killed).toEqual([rootA.id, `${rootA.id}-proxy`]);
  });

  it('does not retry a refused ownership proof', async () => {
    const docker = createDocker({
      containers: [rootA, proxyOf(rootA)],
      discoveries: {
        [rootA.id]: [{ kiloSessionId: 'ses_a', directory: '/workspace/u/worktrees/a' }],
      },
      exclusive: () => false,
    });

    await reclaimOwnedSandboxes([{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }], {
      executeDocker: docker.execute,
      familyGoneTimeoutMs: 20,
      retryMs: 1,
    });

    expect(docker.exclusiveCalls).toHaveLength(1);
  });

  it('reports a scan that keeps failing and leaves every sandbox running', async () => {
    const docker = createDocker({ containers: [rootA, proxyOf(rootA)] });
    const broken: DockerCommandExecutor = async args => {
      if (args[0] === 'exec')
        throw new Error(`Command failed: docker exec ${args[1]} bun -e <script>`);
      return docker.execute(args);
    };

    const report = await reclaimOwnedSandboxes(
      [{ sessionId: 'workspace_a', kiloSessionId: 'ses_a' }],
      {
        executeDocker: broken,
        retryMs: 1,
      }
    );

    expect(report.stopped).toEqual([]);
    expect(report.failures).toEqual([expect.stringContaining('Command failed: docker exec')]);
    expect(docker.killed).toEqual([]);
  });
});

describe('orphan proxies', () => {
  it('finds only proxies whose primary is not running', () => {
    expect(
      findOrphanProxies([proxyOf(rootA), rootB, proxyOf(rootB)]).map(item => item.name)
    ).toEqual([`${rootA.name}-proxy`]);
  });
});
