import { describe, expect, it, vi } from 'vitest';

import {
  killSandboxFamily,
  listSandboxesForAgentSession,
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
