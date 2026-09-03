import { describe, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import type { z } from 'zod';
import {
  ON_PREM_ALLOCATION_REPLAY_WINDOW_MS,
  ON_PREM_CLOCK_SKEW_MS,
  ON_PREM_MAX_LIFETIME_MS,
} from '../../src/shared/onprem-protocol.js';
import {
  KubernetesError,
  bootstrapName,
  namespacedPath,
  type KubernetesClient,
} from './kubernetes.js';
import {
  acceptOperation,
  acknowledgeReports,
  ledgerSchema,
  queueReport,
  requestStop,
  terminationEvidence,
} from './ledger.js';
import { canRetireLedger, createLedgerRetention, type LedgerRecord } from './ledger-retention.js';
import { config, launch, ledgerRecord, now } from './runtime-test-fixtures.js';

const retentionDelay = ON_PREM_ALLOCATION_REPLAY_WINDOW_MS + ON_PREM_CLOCK_SKEW_MS;

function terminalRecord(acknowledgedAt = now + 1000): LedgerRecord {
  const stopped = requestStop(ledgerRecord().ledger, 'user_stop', now);
  const terminal = queueReport(
    { ...stopped, termination: terminationEvidence(stopped, null), cleanupComplete: true },
    'terminal',
    now
  );
  const ids = new Set(terminal.reports.map(report => report.id));
  return ledgerRecord(acknowledgeReports(terminal, ids, ids, acknowledgedAt));
}

function fakeKubernetes(record: LedgerRecord) {
  const path = namespacedPath(config.systemNamespace, 'configmaps', record.resource.metadata.name);
  const resources = new Map<string, unknown>([[path, structuredClone(record.resource)]]);
  let deleteError: Error | undefined;
  let loseResponse = false;
  let failReadAfterDelete = false;
  let deletionAttempted = false;
  let removals = 0;
  const kube: Pick<KubernetesClient, 'get' | 'remove'> = {
    async get<T>(requested: string, schema: z.ZodType<T>): Promise<T | null> {
      if (requested === path && deletionAttempted && failReadAfterDelete)
        throw new KubernetesError(0);
      const value = resources.get(requested);
      return value ? schema.parse(value) : null;
    },
    async remove(requested, uid, grace, resourceVersion) {
      removals++;
      deletionAttempted = true;
      expect(requested).toBe(path);
      expect(grace).toBe(0);
      const current = resources.get(path) as LedgerRecord['resource'] | undefined;
      if (deleteError) throw deleteError;
      if (
        current &&
        (current.metadata.uid !== uid || current.metadata.resourceVersion !== resourceVersion)
      )
        throw new KubernetesError(409);
      resources.delete(path);
      if (loseResponse) throw new KubernetesError(0);
    },
  };
  return {
    kube,
    resources,
    path,
    removals: () => removals,
    rejectDeletion: (error: Error) => {
      deleteError = error;
    },
    loseDeletionResponse: () => {
      loseResponse = true;
    },
    failConfirmation: (fail: boolean) => {
      failReadAfterDelete = fail;
    },
  };
}

describe('completed ledger replay window', () => {
  test('waits for both the hard stop and terminal acknowledgement plus the replay window', () => {
    for (const acknowledgedAt of [now + 1000, launch.hardStopAt + 60_000]) {
      const { ledger } = terminalRecord(acknowledgedAt);
      const boundary = Math.max(launch.hardStopAt, acknowledgedAt) + retentionDelay;
      expect(canRetireLedger(ledger, boundary - 1)).toBe(false);
      expect(canRetireLedger(ledger, boundary)).toBe(true);
      expect(
        canRetireLedger(ledgerSchema.parse(JSON.parse(JSON.stringify(ledger))), boundary)
      ).toBe(true);
    }
  });

  test('retains active, unresolved, incompletely cleaned, unacknowledged and stop-only records', () => {
    const { ledger } = terminalRecord();
    const boundary = launch.hardStopAt + retentionDelay;
    for (const retained of [
      ledgerRecord().ledger,
      { ...ledger, cleanupComplete: false },
      { ...ledger, termination: null },
      { ...ledger, stop: null },
      { ...ledger, launch: null },
      { ...ledger, terminalReportAcknowledgedAt: null },
      { ...ledger, revision: ledger.revision + 1 },
      queueReport(ledger, 'unknown', now + 10_000, 'pod_absence_unconfirmed'),
      queueReport(ledger, 'terminal', now + 10_000),
    ])
      expect(canRetireLedger(retained, boundary)).toBe(false);
  });

  test('retires acknowledged stop-only fences only after the maximum possible lifetime and replay window', () => {
    const stopped = acceptOperation(
      null,
      {
        id: crypto.randomUUID(),
        allocationId: launch.allocationId,
        sandboxId: launch.sandboxId,
        providerRef: launch.providerRef,
        revision: launch.revision + 1,
        type: 'stop',
        reason: 'user_stop',
      },
      config,
      now
    );
    const reporting = queueReport(
      { ...stopped, termination: terminationEvidence(stopped, null), cleanupComplete: true },
      'terminal',
      now
    );
    const ids = new Set(reporting.reports.map(report => report.id));
    const acknowledgedAt = now + 1000;
    const ledger = acknowledgeReports(reporting, ids, ids, acknowledgedAt);
    const boundary = acknowledgedAt + ON_PREM_MAX_LIFETIME_MS + retentionDelay;
    expect(ledger.launch).toBeNull();
    expect(canRetireLedger(ledger, boundary - 1)).toBe(false);
    expect(canRetireLedger(ledger, boundary)).toBe(true);
    expect(canRetireLedger({ ...ledger, terminalReportAcknowledgedAt: null }, boundary)).toBe(
      false
    );
    expect(acceptOperation(null, launch, config, boundary).stop?.reason).toBe('launch_expired');
  });

  test('legacy records need a newly sent and acknowledged terminal report', () => {
    const { terminalReportAcknowledgedAt: _timestamp, ...legacy } = terminalRecord().ledger;
    const restored = ledgerSchema.parse(legacy);
    const boundary = launch.hardStopAt + retentionDelay;
    expect(restored.terminalReportAcknowledgedAt).toBeNull();
    expect(canRetireLedger(restored, boundary)).toBe(false);
    const reporting = queueReport(restored, 'terminal', now);
    const ids = new Set(reporting.reports.map(report => report.id));
    expect(
      acknowledgeReports(reporting, ids, new Set(), boundary).terminalReportAcknowledgedAt
    ).toBeNull();
    expect(
      acknowledgeReports(reporting, new Set(), ids, boundary).terminalReportAcknowledgedAt
    ).toBeNull();
    const acknowledged = acknowledgeReports(reporting, ids, ids, boundary);
    expect(acknowledged.terminalReportAcknowledgedAt).toBe(boundary);
    expect(canRetireLedger(acknowledged, boundary + retentionDelay - 1)).toBe(false);
    expect(canRetireLedger(acknowledged, boundary + retentionDelay)).toBe(true);
  });

  test('an acknowledgement for an older revision cannot authorize retirement', () => {
    const reporting = queueReport(
      { ...terminalRecord().ledger, terminalReportAcknowledgedAt: null },
      'terminal',
      now
    );
    const ids = new Set(reporting.reports.map(report => report.id));
    const acknowledged = acknowledgeReports(
      { ...reporting, revision: reporting.revision + 1 },
      ids,
      ids,
      now + 1000
    );
    expect(acknowledged.terminalReportAcknowledgedAt).toBeNull();
  });

  test('a launch replay cannot create a new runtime after retirement or a restart', () => {
    const boundary = launch.hardStopAt + retentionDelay;
    expect(canRetireLedger(terminalRecord().ledger, boundary)).toBe(true);
    const replay = acceptOperation(null, launch, config, boundary);
    expect(replay.stop?.reason).toBe('launch_expired');
    expect(replay.launch).toBeNull();
    expect(replay.createRequested).toBe(false);
    expect(acceptOperation(ledgerSchema.parse(replay), launch, config, boundary + 1).stop).toEqual(
      replay.stop
    );
  });
});

describe('guarded ledger deletion', () => {
  const boundary = launch.hardStopAt + retentionDelay;

  test('deletes only owned completed records with their UID and resourceVersion', async () => {
    const record = terminalRecord();
    const fake = fakeKubernetes(record);
    const retention = createLedgerRetention(fake.kube, config);
    expect(await retention.retire(record, boundary - 1)).toBe(false);
    expect(fake.removals()).toBe(0);
    expect(await retention.retire(record, boundary)).toBe(true);
    expect(fake.resources.has(fake.path)).toBe(false);
    expect(retention.isPending(record)).toBe(true);
    retention.forget(record.ledger.allocationId);
    expect(retention.isPending(record)).toBe(false);
  });

  test.each(['uid', 'resourceVersion'] as const)(
    'does not delete a concurrent %s change',
    async field => {
      const record = terminalRecord();
      const fake = fakeKubernetes(record);
      const replacement = {
        ...record.resource,
        metadata: { ...record.resource.metadata, [field]: 'replacement' },
      };
      fake.resources.set(fake.path, replacement);
      fake.failConfirmation(true);
      const retention = createLedgerRetention(fake.kube, config);
      await rejects(retention.retire(record, boundary), { status: 409 });
      expect(retention.isPending(record)).toBe(false);
      expect(fake.resources.get(fake.path)).toEqual(replacement);
    }
  );

  test('a rejected deletion never permits an intentional-missing cache transition', async () => {
    const record = terminalRecord();
    const fake = fakeKubernetes(record);
    fake.rejectDeletion(new KubernetesError(403));
    const retention = createLedgerRetention(fake.kube, config);
    await rejects(retention.retire(record, boundary), { status: 403 });
    expect(retention.isPending(record)).toBe(false);
    expect(fake.resources.has(fake.path)).toBe(true);
  });

  test('confirms a lost deletion response by absence and permits idempotent retry', async () => {
    const record = terminalRecord();
    const fake = fakeKubernetes(record);
    fake.loseDeletionResponse();
    const retention = createLedgerRetention(fake.kube, config);
    expect(await retention.retire(record, boundary)).toBe(true);
    expect(await retention.retire(record, boundary)).toBe(true);
    expect(fake.removals()).toBe(2);
  });

  test('preserves ambiguous deletion state until later confirmation without matching a new version', async () => {
    const record = terminalRecord();
    const fake = fakeKubernetes(record);
    fake.loseDeletionResponse();
    fake.failConfirmation(true);
    const retention = createLedgerRetention(fake.kube, config);
    await rejects(retention.retire(record, boundary), { status: 0 });
    expect(retention.isPending(record)).toBe(true);
    expect(
      retention.isPending({
        ...record,
        resource: {
          ...record.resource,
          metadata: { ...record.resource.metadata, resourceVersion: '8' },
        },
      })
    ).toBe(false);
    fake.failConfirmation(false);
    expect(await retention.retire(record, boundary)).toBe(true);
  });

  test('keeps a timed-out deletion pending when the unchanged ledger can disappear later', async () => {
    const record = terminalRecord();
    const fake = fakeKubernetes(record);
    fake.rejectDeletion(new KubernetesError(0));
    const retention = createLedgerRetention(fake.kube, config);
    await rejects(retention.retire(record, boundary), { status: 0 });
    expect(retention.isPending(record)).toBe(true);
    expect(fake.resources.has(fake.path)).toBe(true);
    fake.resources.delete(fake.path);
    expect(retention.isPending(record)).toBe(true);
  });

  test.each(['uid', 'resourceVersion'] as const)(
    'forgets ambiguous deletion when the observed %s has changed',
    async field => {
      const record = terminalRecord();
      const fake = fakeKubernetes(record);
      fake.rejectDeletion(new KubernetesError(0));
      fake.resources.set(fake.path, {
        ...record.resource,
        metadata: { ...record.resource.metadata, [field]: 'replacement' },
      });
      const retention = createLedgerRetention(fake.kube, config);
      await rejects(retention.retire(record, boundary), { status: 0 });
      expect(retention.isPending(record)).toBe(false);
      expect(fake.resources.has(fake.path)).toBe(true);
    }
  );

  test('does not delete foreign ownership, finalizers, or remaining native resources', async () => {
    const record = terminalRecord();
    const fake = fakeKubernetes(record);
    const retention = createLedgerRetention(fake.kube, config);
    await rejects(
      retention.retire(
        {
          ...record,
          resource: { ...record.resource, metadata: { ...record.resource.metadata, labels: {} } },
        },
        boundary
      ),
      new Error('ledger_owner_mismatch')
    );
    expect(
      await retention.retire(
        {
          ...record,
          resource: {
            ...record.resource,
            metadata: { ...record.resource.metadata, finalizers: ['other'] },
          },
        },
        boundary
      )
    ).toBe(false);
    fake.resources.set(
      namespacedPath(config.sandboxNamespace, 'secrets', bootstrapName(launch.allocationId)),
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { ...record.resource.metadata, namespace: config.sandboxNamespace },
      }
    );
    expect(await retention.retire(record, boundary)).toBe(false);
    expect(fake.removals()).toBe(0);
  });
});
