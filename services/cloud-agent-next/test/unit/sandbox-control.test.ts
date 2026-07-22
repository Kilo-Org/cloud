import { describe, expect, it, vi } from 'vitest';

import {
  killSandboxFamily,
  listSandboxesForAgentSession,
  removeSandboxFamily,
  waitForSandboxCleanupQuiescence,
  waitForNewSandboxPresent,
  type DockerCommandExecutor,
  type SandboxContainer,
} from '../e2e/sandbox-control.js';

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

function dockerPsOutput(containers: SandboxContainer[]): string {
  return containers
    .map(container => `${container.id}\t${container.name}\t${container.image}`)
    .join('\n');
}

function createDockerExecutor(
  containers: SandboxContainer[],
  markerContainerIds: Set<string> = new Set()
): DockerCommandExecutor {
  return vi.fn(async args => {
    if (args[0] === 'ps') return { stdout: dockerPsOutput(containers) };
    if (args[0] === 'kill') return { stdout: args[1] ?? '' };
    if (args[0] === 'rm') return { stdout: args[2] ?? '' };
    if (args[0] === 'exec' && args[1] && markerContainerIds.has(args[1])) return { stdout: '' };
    if (args[0] === 'exec') throw Object.assign(new Error('wrapper marker not found'), { code: 1 });
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  });
}

describe('listSandboxesForAgentSession', () => {
  it('returns only the primary container with a root-correlated wrapper marker', async () => {
    const executeDocker = createDockerExecutor(
      [ownedPrimary, unrelatedPrimary, ownedProxy],
      new Set([ownedPrimary.id])
    );

    await expect(listSandboxesForAgentSession('agent_owned', executeDocker)).resolves.toEqual([
      ownedPrimary,
    ]);
    expect(executeDocker).toHaveBeenCalledWith([
      'exec',
      ownedPrimary.id,
      'sh',
      '-c',
      'for log in /tmp/kilocode-wrapper-"$1"-*.log; do test -e "$log" && exit 0; done; exit 1',
      'sandbox-wrapper-log-match',
      'agent_owned',
    ]);
    expect(executeDocker).toHaveBeenCalledWith([
      'exec',
      unrelatedPrimary.id,
      'sh',
      '-c',
      'for log in /tmp/kilocode-wrapper-"$1"-*.log; do test -e "$log" && exit 0; done; exit 1',
      'sandbox-wrapper-log-match',
      'agent_owned',
    ]);
    expect(executeDocker).not.toHaveBeenCalledWith(expect.arrayContaining(['exec', ownedProxy.id]));
  });

  it('returns no family when no primary has a root-correlated wrapper marker', async () => {
    const executeDocker = createDockerExecutor([ownedPrimary, unrelatedPrimary, ownedProxy]);

    await expect(listSandboxesForAgentSession('agent_owned', executeDocker)).resolves.toEqual([]);
  });
});

describe('waitForNewSandboxPresent', () => {
  it('accepts a warm-pool container only when its wrapper marker owns the session', async () => {
    const executeDocker = createDockerExecutor(
      [unrelatedPrimary, ownedPrimary],
      new Set([ownedPrimary.id])
    );

    await expect(
      waitForNewSandboxPresent(new Set([ownedPrimary.id]), 100, 'agent_owned', executeDocker)
    ).resolves.toEqual(ownedPrimary);
  });
});

describe('killSandboxFamily', () => {
  it('kills only the selected family exact primary and proxy containers', async () => {
    const similarlyNamedPrimary: SandboxContainer = {
      id: 'similarly-named-primary-id',
      name: `${ownedPrimary.name}-replacement`,
      image: 'cloudflare/sandbox:latest',
      isProxy: false,
    };
    const executeDocker = createDockerExecutor([
      ownedPrimary,
      ownedProxy,
      unrelatedPrimary,
      similarlyNamedPrimary,
    ]);

    await expect(killSandboxFamily(ownedPrimary, executeDocker)).resolves.toEqual([
      ownedPrimary.name,
      ownedProxy.name,
    ]);
    expect(executeDocker).toHaveBeenCalledWith(['kill', ownedPrimary.id]);
    expect(executeDocker).toHaveBeenCalledWith(['kill', ownedProxy.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', unrelatedPrimary.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', similarlyNamedPrimary.id]);
  });
});

describe('removeSandboxFamily', () => {
  it('force-removes only exact primary and proxy names, including stopped containers', async () => {
    const similarlyNamedPrimary: SandboxContainer = {
      id: 'similarly-named-primary-id',
      name: `${ownedPrimary.name}-replacement`,
      image: 'cloudflare/sandbox:latest',
      isProxy: false,
    };
    const executeDocker = createDockerExecutor([
      ownedPrimary,
      ownedProxy,
      unrelatedPrimary,
      similarlyNamedPrimary,
    ]);

    await expect(removeSandboxFamily(ownedPrimary, executeDocker)).resolves.toEqual([
      ownedPrimary.name,
      ownedProxy.name,
    ]);
    expect(executeDocker).toHaveBeenCalledWith([
      'ps',
      '-a',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Image}}',
    ]);
    expect(executeDocker).toHaveBeenCalledWith(['rm', '-f', ownedPrimary.id]);
    expect(executeDocker).toHaveBeenCalledWith(['rm', '-f', ownedProxy.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['rm', '-f', unrelatedPrimary.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['rm', '-f', similarlyNamedPrimary.id]);
  });
});

function createSequencedDockerExecutor(observations: SandboxContainer[][]): DockerCommandExecutor {
  let index = 0;
  return vi.fn(async args => {
    if (args[0] === 'ps') {
      const containers = observations[Math.min(index, observations.length - 1)] ?? [];
      index += 1;
      return { stdout: dockerPsOutput(containers) };
    }
    if (args[0] === 'kill' || args[0] === 'rm') return { stdout: args.at(-1) ?? '' };
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  });
}

function controlledTime(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let timestamp = 0;
  return {
    now: () => timestamp,
    sleep: async ms => {
      timestamp += ms;
    },
  };
}

describe('waitForSandboxCleanupQuiescence', () => {
  it('ignores baseline containers and requires an uninterrupted absence window', async () => {
    const time = controlledTime();
    const executeDocker = createSequencedDockerExecutor([[unrelatedPrimary]]);

    await expect(
      waitForSandboxCleanupQuiescence(new Set([unrelatedPrimary.id]), {
        timeoutMs: 2_000,
        stableMs: 1_000,
        pollIntervalMs: 250,
        executeDocker,
        ...time,
      })
    ).resolves.toBe(true);
    expect(time.now()).toBe(1_000);
  });

  it('resets the absence window when a post-baseline sandbox transiently reappears', async () => {
    const time = controlledTime();
    const executeDocker = createSequencedDockerExecutor([
      [unrelatedPrimary],
      [unrelatedPrimary, ownedPrimary],
      [unrelatedPrimary],
    ]);

    await expect(
      waitForSandboxCleanupQuiescence(new Set([unrelatedPrimary.id]), {
        timeoutMs: 2_000,
        stableMs: 500,
        reapPostBaseline: true,
        pollIntervalMs: 250,
        executeDocker,
        ...time,
      })
    ).resolves.toBe(true);
    expect(time.now()).toBe(1_000);
    expect(executeDocker).toHaveBeenCalledWith(['kill', ownedPrimary.id]);
    expect(executeDocker).toHaveBeenCalledWith(['rm', '-f', ownedPrimary.id]);
  });

  it('does not bypass runtime teardown while waiting on the normal path', async () => {
    const time = controlledTime();
    const executeDocker = createSequencedDockerExecutor([[ownedPrimary], []]);

    await expect(
      waitForSandboxCleanupQuiescence(new Set(), {
        timeoutMs: 1_000,
        stableMs: 500,
        pollIntervalMs: 250,
        executeDocker,
        ...time,
      })
    ).resolves.toBe(true);
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', ownedPrimary.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['rm', '-f', ownedPrimary.id]);
  });

  it('times out while a post-baseline sandbox remains present', async () => {
    const time = controlledTime();
    const executeDocker = createSequencedDockerExecutor([[ownedPrimary]]);

    await expect(
      waitForSandboxCleanupQuiescence(new Set(), {
        timeoutMs: 1_000,
        stableMs: 500,
        pollIntervalMs: 250,
        executeDocker,
        ...time,
      })
    ).resolves.toBe(false);
    expect(time.now()).toBe(1_000);
  });
});
