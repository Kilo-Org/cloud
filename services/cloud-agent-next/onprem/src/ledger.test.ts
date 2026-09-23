import { describe, expect, test } from 'bun:test';
import {
  ON_PREM_ALLOCATION_REPLAY_WINDOW_MS,
  ON_PREM_CLOCK_SKEW_MS,
  encodeOnPremProviderRef,
} from '../../src/shared/onprem-protocol.js';
import { canRetireLedger } from './ledger-retention.js';
import { onPremConfigSchema, podSchema, type Pod } from './kubernetes.js';
import {
  acceptOperation,
  acknowledgeReports,
  canOpenGate,
  ledgerSchema,
  pinPod,
  queueReport,
  requestStop,
  terminationEvidence,
  type AllocationLedger,
  type LaunchOperation,
} from './ledger.js';
import { allocationPod } from './provisioner.js';

const now = Date.parse('2026-09-02T12:00:00Z');
const allocationId = '11111111-1111-4111-8111-111111111111';
const installationId = '22222222-2222-4222-8222-222222222222';
const config = onPremConfigSchema.parse({
  cloudUrl: 'http://host.docker.internal:8790',
  organizationId: '33333333-3333-4333-8333-333333333333',
  installationId,
  cloudIPv4: '192.168.5.2',
  dnsIPv4: '10.43.0.10',
  brokerClusterIp: '10.43.0.20',
  profile: {
    id: 'local',
    revision: 'v1',
    runtimeClass: 'gvisor',
    image: 'kilo-runtime:qualified',
    brokerUrl: 'https://kilo-onprem-broker.kilo-onprem-system.svc',
    maxLifetimeMs: 600_000,
  },
  upstreams: {
    backendBaseUrl: 'http://host.docker.internal:3000',
    providerBaseUrl: 'http://host.docker.internal:3000',
    sessionIngestBaseUrl: 'http://host.docker.internal:8792',
  },
});
const providerRef = encodeOnPremProviderRef({ installationId, allocationId });
const launch: LaunchOperation = {
  id: '44444444-4444-4444-8444-444444444444',
  allocationId,
  providerRef,
  sandboxId: 'sandbox-test',
  revision: 1,
  type: 'launch',
  profileId: 'local',
  profileRevision: 'v1',
  hardStopAt: now + 600_000,
  notAfter: now + 120_000,
  bootstrap: {
    SANDBOX_CONTROL_URL: 'ws://host.docker.internal:8790/sandbox-control/sandbox-test',
    SANDBOX_CONTROL_CREDENTIAL: 'allocation-scoped-test-capability',
    PROVIDER_INSTANCE_ID: providerRef,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  },
};
const stop = {
  id: '55555555-5555-4555-8555-555555555555',
  allocationId,
  providerRef,
  sandboxId: launch.sandboxId,
  revision: 2,
  type: 'stop',
  reason: 'user_stop',
} as const;

function created() {
  const ledger = acceptOperation(null, launch, config, now);
  const manifest = allocationPod(config, ledger);
  const pod = podSchema.parse({
    ...manifest,
    metadata: {
      ...manifest.metadata,
      uid: '66666666-6666-4666-8666-666666666666',
      resourceVersion: '1',
    },
    status: { phase: 'Pending' },
  });
  return { ledger: pinPod(ledger, pod), pod };
}

function running(pod: Pod): Pod {
  return {
    ...pod,
    spec: { ...pod.spec, schedulingGates: [], nodeName: 'local-node' },
    status: {
      phase: 'Running',
      podIP: '10.42.0.8',
      containerStatuses: [
        {
          name: 'sandbox',
          containerID: 'containerd://test',
          restartCount: 0,
          state: { running: { startedAt: new Date(now).toISOString() } },
        },
      ],
    },
  };
}

function terminated(pod: Pod, reason = 'Completed'): Pod {
  return {
    ...running(pod),
    status: {
      phase: 'Succeeded',
      containerStatuses: [
        {
          name: 'sandbox',
          containerID: 'containerd://test',
          state: {
            terminated: { exitCode: 0, reason, finishedAt: new Date(now + 20_000).toISOString() },
          },
        },
      ],
    },
  };
}

describe('durable allocation boundaries', () => {
  test('duplicate launch preserves intent and does not add another receipt', () => {
    const first = acceptOperation(null, launch, config, now);
    const reordered = {
      ...launch,
      bootstrap: Object.fromEntries(Object.entries(launch.bootstrap).reverse()),
    };
    expect(acceptOperation(first, reordered, config, now + 1000)).toEqual(first);
    expect(first.receipts).toHaveLength(1);
    expect(first.createRequested).toBe(false);
  });

  test('stop before launch dominates even a later revision after a ledger reload', () => {
    const stopped = acceptOperation(null, stop, config, now);
    const restored = ledgerSchema.parse(JSON.parse(JSON.stringify(stopped)));
    const replay = acceptOperation(restored, { ...launch, revision: 10 }, config, now + 1);
    expect(replay.stop?.reason).toBe('user_stop');
    expect(replay.launch).toBeNull();
    expect(replay.createRequested).toBe(false);
  });

  test('changed operation payload and changed local profile fail closed', () => {
    const first = acceptOperation(null, launch, config, now);
    const changed = {
      ...launch,
      bootstrap: { ...launch.bootstrap, SANDBOX_CONTROL_CREDENTIAL: 'different-capability' },
    };
    expect(acceptOperation(first, changed, config, now).stop?.reason).toBe('operation_conflict');
    expect(
      acceptOperation(
        first,
        launch,
        { ...config, resources: { ...config.resources, cpuMillis: 2000 } },
        now
      ).stop?.reason
    ).toBe('launch_conflict');
    expect(JSON.stringify(first)).not.toContain(launch.bootstrap.SANDBOX_CONTROL_CREDENTIAL);
    expect(ledgerSchema.safeParse({ ...first, bootstrap: launch.bootstrap }).success).toBe(false);
  });

  test('catalog updates and removal preserve accepted allocations and launch authority', () => {
    const { ledger } = created();
    const pending = queueReport(ledger, 'pending', now);
    const id = pending.reports[0]!.id;
    const registered = acknowledgeReports(pending, new Set([id]), new Set([id]), now);
    for (const instanceTypes of [
      [
        {
          id: 'small',
          displayName: 'Small',
          resources: {
            cpuMillis: config.resources.cpuMillis,
            memoryMiB: config.resources.memoryMiB,
            diskMiB: config.resources.diskMiB,
          },
        },
      ],
      [
        {
          id: 'large',
          displayName: 'Large',
          resources: { cpuMillis: 4000, memoryMiB: 8192, diskMiB: 16384 },
        },
      ],
      [],
    ]) {
      const advertised = onPremConfigSchema.parse({ ...config, instanceTypes });
      expect(acceptOperation(registered, launch, advertised, now + 1000)).toEqual(registered);
      expect(canOpenGate(registered, advertised, now + 1000)).toBe(true);
    }
  });

  test('registration requires acknowledgement of the actual sent pending report', () => {
    const { ledger } = created();
    const pending = queueReport(ledger, 'pending', now, 'awaiting_registration');
    const id = pending.reports[0]!.id;
    expect(queueReport(pending, 'pending', now + 5000, 'awaiting_registration').reports).toEqual(
      pending.reports
    );
    expect(acknowledgeReports(pending, new Set([id]), new Set(), now).registered).toBe(false);
    const registered = acknowledgeReports(pending, new Set([id]), new Set([id]), now);
    expect(canOpenGate(registered, config, now + 1)).toBe(true);
    expect(canOpenGate(registered, config, launch.notAfter)).toBe(false);
  });

  test('stop is applied before a registration acknowledgement from the same exchange', () => {
    const { ledger } = created();
    const pending = queueReport(ledger, 'pending', now);
    const id = pending.reports[0]!.id;
    const stopped = acceptOperation(pending, stop, config, now);
    const acknowledged = acknowledgeReports(stopped, new Set([id]), new Set([id]), now);
    expect(acknowledged.registered).toBe(false);
    expect(canOpenGate(acknowledged, config, now)).toBe(false);
  });

  test.each([false, true])(
    'Stop removes obsolete registration reports through terminal acknowledgement (legacy: %s)',
    legacy => {
      const { ledger, pod } = created();
      const pending = queueReport(ledger, 'pending', now);
      const stopped = legacy
        ? ledgerSchema.parse({
            ...pending,
            revision: stop.revision,
            stop: { reason: stop.reason, requestedAt: now },
          })
        : acceptOperation(pending, stop, config, now);
      expect(stopped.reports).toEqual([]);
      expect(stopped.registered).toBe(false);
      expect(canOpenGate(stopped, config, now)).toBe(false);
      const reporting = queueReport(
        {
          ...stopped,
          termination: terminationEvidence(stopped, terminated(pod)),
          cleanupComplete: true,
        },
        'terminal',
        now + 25_000
      );
      const ids = new Set(reporting.reports.map(report => report.id));
      const acknowledged = acknowledgeReports(reporting, ids, ids, now + 25_000);
      expect(acknowledged.reports).toEqual([]);
      expect(
        canRetireLedger(
          acknowledged,
          launch.hardStopAt + ON_PREM_ALLOCATION_REPLAY_WINDOW_MS + ON_PREM_CLOCK_SKEW_MS
        )
      ).toBe(true);
    }
  );

  test('a pinned UID cannot change, even to a terminated Pod', () => {
    const { ledger, pod } = created();
    const replaced = {
      ...terminated(pod),
      metadata: { ...pod.metadata, uid: '77777777-7777-4777-8777-777777777777' },
    };
    expect(() => pinPod(ledger, replaced)).toThrow('pod_identity_conflict');
    expect(terminationEvidence(requestStop(ledger, 'user_stop', now), replaced)).toBeNull();
  });

  test('missing, deleting, deadline-expired and ambiguous ungate states are not death', () => {
    const { ledger, pod } = created();
    const stopping: AllocationLedger = {
      ...requestStop(ledger, 'lifetime_expired', launch.hardStopAt),
      gate: 'open',
    };
    expect(terminationEvidence(stopping, null)).toBeNull();
    expect(
      terminationEvidence(stopping, {
        ...running(pod),
        metadata: { ...pod.metadata, deletionTimestamp: new Date(now).toISOString() },
      })
    ).toBeNull();
    expect(terminationEvidence({ ...stopping, pod: null, createRequested: true }, null)).toBeNull();
    expect(
      terminationEvidence(
        { ...stopping, gate: 'opening' },
        { ...pod, metadata: { ...pod.metadata, deletionTimestamp: new Date(now).toISOString() } }
      )
    ).toBeNull();
    expect(() => queueReport(stopping, 'terminal', now)).toThrow('termination_unconfirmed');
  });

  test('only a fenced never-scheduled Pod or actual container termination confirms death', () => {
    const { ledger, pod } = created();
    const stopping = requestStop(ledger, 'user_stop', now);
    expect(terminationEvidence(stopping, pod)).toBeNull();
    expect(
      terminationEvidence(stopping, {
        ...pod,
        metadata: { ...pod.metadata, deletionTimestamp: new Date(now).toISOString() },
      })?.evidence
    ).toBe('never_scheduled');
    expect(terminationEvidence({ ...stopping, gate: 'open' }, terminated(pod))?.evidence).toBe(
      'containers_terminated'
    );
    expect(terminationEvidence(stopping, terminated(pod, 'ContainerStatusUnknown'))).toBeNull();
    const lost = terminated(pod);
    expect(
      terminationEvidence(stopping, { ...lost, status: { ...lost.status, reason: 'NodeLost' } })
    ).toBeNull();
  });

  test('terminal report retries and newer stop revisions retain the original evidence time', () => {
    const { ledger, pod } = created();
    const stopped = requestStop(ledger, 'user_stop', now);
    const terminal = { ...stopped, termination: terminationEvidence(stopped, terminated(pod)) };
    const reported = queueReport(terminal, 'terminal', now + 50_000);
    expect(reported.reports[0]?.observedAt).toBe(now + 20_000);
    const id = reported.reports[0]!.id;
    expect(queueReport(reported, 'terminal', now + 60_000).reports).toEqual(reported.reports);
    const acknowledged = acknowledgeReports(reported, new Set([id]), new Set([id]), now + 50_000);
    const retried = queueReport(acknowledged, 'terminal', now + 60_000);
    expect(retried.reports).toHaveLength(1);
    expect(retried.reports[0]?.id).not.toBe(id);
    expect(retried.reports[0]?.observedAt).toBe(now + 20_000);
    const newer = acceptOperation(acknowledged, stop, config, now + 60_000);
    expect(queueReport(newer, 'terminal', now + 60_000).reports[0]?.observedAt).toBe(now + 20_000);
  });
});
