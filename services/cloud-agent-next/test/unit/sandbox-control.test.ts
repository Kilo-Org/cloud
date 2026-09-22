import { describe, expect, it, vi } from 'vitest';

import {
  isSandboxPrimaryGone,
  killSandboxFamily,
  listSandboxesForAgentSession,
  waitForSandboxPrimaryGone,
  type DockerCommandExecutor,
  type SandboxContainer,
} from '../e2e/sandbox-control.js';
import {
  matchIdleStopEvidence,
  parseFramedLogRecords,
  type LogRecord,
} from '../e2e/idle-stop-evidence.js';

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

describe('primary sandbox absence', () => {
  it('treats a proxy-only remnant as primary-gone', () => {
    expect(isSandboxPrimaryGone([ownedProxy], ownedPrimary.id)).toBe(true);
    expect(isSandboxPrimaryGone([unrelatedPrimary, ownedProxy], ownedPrimary.id)).toBe(true);
    expect(isSandboxPrimaryGone([ownedPrimary, ownedProxy], ownedPrimary.id)).toBe(false);
  });

  it('resolves the wait once only the proxy sidecar remains', async () => {
    const executeDocker = createDockerExecutor([ownedProxy]);
    await expect(waitForSandboxPrimaryGone(ownedPrimary, 1_000, executeDocker)).resolves.toBe(true);
  });
});

const ownedIdleInitiation = (overrides: Record<string, unknown> = {}): LogRecord => ({
  message: 'Sandbox control diagnostic',
  level: 'info',
  time: 2_000,
  tags: { $logger: { level: 'debug' } },
  sandboxId: 'sandbox-owned',
  allocationId: 'allocation-owned',
  physicalSandboxId: 'physical-owned',
  wrapperInstanceId: 'wrapper-owned',
  fromState: 'running',
  toState: 'stopping',
  cause: 'idle',
  logTag: 'sandbox_control',
  diagnosticEvent: 'physical_committed',
  ...overrides,
});

const ownedTerminalStop: LogRecord = {
  message: 'Sandbox control diagnostic',
  level: 'info',
  time: 3_000,
  tags: { $logger: { level: 'debug' } },
  sandboxId: 'sandbox-owned',
  allocationId: 'allocation-owned',
  physicalSandboxId: 'physical-owned',
  wrapperInstanceId: 'wrapper-owned',
  result: 'terminal',
  logTag: 'sandbox_control',
  diagnosticEvent: 'provider_stop',
};

describe('idle-stop log framing and evidence', () => {
  it('frames a sanitized pretty-printed local excerpt across chunk boundaries', () => {
    const excerpt = `wrangler:info\n{
  message: 'Sandbox control diagnostic',
  level: 'info',
  time: 2000,
  tags: { '$logger': { level: 'debug' } },
  sandboxId: 'sandbox-owned',
  allocationId: 'allocation-owned',
  physicalSandboxId: 'physical-owned',
  wrapperInstanceId: 'wrapper-owned',
  fromState: 'running',
  toState: 'stopping',
  cause: 'idle',
  logTag: 'sandbox_control',
  diagnosticEvent: 'physical_committed'
}
{
  message: 'Sandbox control diagnostic',
  level: 'info',
  time: 3000,
  tags: { '$logger': { level: 'debug' } },
  sandboxId: 'sandbox-owned',
  allocationId: 'allocation-owned',
  physicalSandboxId: 'physical-owned',
  wrapperInstanceId: 'wrapper-owned',
  result: 'terminal',
  logTag: 'sandbox_control',
  diagnosticEvent: 'provider_stop'
}\n`;
    const chunks: string[] = [];
    for (let offset = 0; offset < excerpt.length; offset += 11) {
      chunks.push(excerpt.slice(offset, offset + 11));
    }

    const records = parseFramedLogRecords(chunks);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      allocationId: 'allocation-owned',
      physicalSandboxId: 'physical-owned',
      diagnosticEvent: 'physical_committed',
    });
    expect(
      matchIdleStopEvidence(records, {
        allocationId: 'allocation-owned',
        physicalSandboxId: 'physical-owned',
        cursorCapturedAt: 1_000,
      })
    ).toMatchObject({
      physicalCommittedAt: 2_000,
      providerStopAt: 3_000,
      elapsedMs: 2_000,
    });
    expect(
      parseFramedLogRecords([
        '2026-09-11T00:00:00Z ',
        '{"logTag":"sandbox_control","diagnosticEvent":"other"}\n',
      ])
    ).toEqual([{ logTag: 'sandbox_control', diagnosticEvent: 'other' }]);
  });

  it('does not treat a stopping-to-stopping stop attempt as idle initiation', () => {
    expect(
      matchIdleStopEvidence(
        [
          ownedIdleInitiation({
            fromState: 'stopping',
            toState: 'stopping',
            cause: 'stop_attempt',
            stopCause: 'idle',
          }),
          ownedTerminalStop,
        ],
        {
          allocationId: 'allocation-owned',
          physicalSandboxId: 'physical-owned',
          cursorCapturedAt: 1_000,
        }
      )
    ).toBeNull();
  });

  it('ignores another sandbox idle deadline and an owned non-idle deadline', () => {
    const records: LogRecord[] = [
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'deadline_fired',
        deadlineId: 'idleStop',
        deadlineAt: 1_500,
        sandboxId: 'sandbox-other',
        physicalSandboxId: 'physical-other',
      },
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'deadline_fired',
        deadlineId: 'heartbeatExpiry',
        deadlineAt: 1_750,
        sandboxId: 'sandbox-owned',
        physicalSandboxId: 'physical-owned',
      },
      ownedIdleInitiation(),
      ownedTerminalStop,
    ];
    expect(
      matchIdleStopEvidence(records, {
        allocationId: 'allocation-owned',
        physicalSandboxId: 'physical-owned',
        cursorCapturedAt: 1_000,
      })
    ).toMatchObject({
      physicalCommittedAt: 2_000,
      providerStopAt: 3_000,
      elapsedMs: 2_000,
    });
    expect(
      matchIdleStopEvidence(records, {
        allocationId: 'allocation-owned',
        physicalSandboxId: 'physical-owned',
        cursorCapturedAt: 1_000,
      })?.deadlineAt
    ).toBeUndefined();
  });

  it('matches production records by the durable sandbox id, not the Docker family name', () => {
    const durableSandboxId = 'ses-e6bbc28ff55c4ae31bb72d3b06b2304367355dc4102ca96a';
    const allocationName = 'ses-c03b955ecf30b89fd7be09014a7e34e5d1b674464b566eb7';
    const dockerFamilyName = 'workerd-abc-SandboxSmall-0123456789abcdef';
    const records: LogRecord[] = [
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'physical_committed',
        time: 2_000,
        sandboxId: durableSandboxId,
        allocationId: '2d49a855-427d-4561-b79a-c53ebc701075',
        physicalSandboxId: allocationName,
        wrapperInstanceId: '923ff13e-4dc7-42d5-b2ab-1960e74c9003',
        fromState: 'running',
        toState: 'stopping',
        cause: 'idle',
      },
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'provider_stop',
        time: 3_000,
        sandboxId: durableSandboxId,
        allocationId: '2d49a855-427d-4561-b79a-c53ebc701075',
        wrapperInstanceId: '923ff13e-4dc7-42d5-b2ab-1960e74c9003',
        result: 'terminal',
      },
    ];

    expect(
      matchIdleStopEvidence(records, {
        allocationId: durableSandboxId,
        sandboxId: durableSandboxId,
        cursorCapturedAt: 1_000,
      })
    ).toMatchObject({
      physicalCommittedAt: 2_000,
      providerStopAt: 3_000,
      elapsedMs: 2_000,
    });

    // The Docker family name is neither the durable id nor the derived
    // physical id, so it must not match the production records.
    expect(
      matchIdleStopEvidence(records, {
        allocationId: dockerFamilyName,
        physicalSandboxId: dockerFamilyName,
        cursorCapturedAt: 1_000,
      })
    ).toBeNull();
  });
});
