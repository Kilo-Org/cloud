import { describe, expect, spyOn, test } from 'bun:test';
import type { z } from 'zod';
import {
  ON_PREM_ALLOCATION_REPLAY_WINDOW_MS,
  ON_PREM_CLOCK_SKEW_MS,
  onPremExchangeRequestSchema,
  type OnPremExchangeRequest,
  type OnPremExchangeResponse,
} from '../../src/shared/onprem-protocol.js';
import * as kubernetes from './kubernetes.js';
import {
  acknowledgeReports,
  ledgerSchema,
  pinPod,
  queueReport,
  requestStop,
  terminationEvidence,
} from './ledger.js';
import { type LedgerRecord } from './ledger-retention.js';
import { allocationPod, createProvisioner } from './provisioner.js';
import { config, launch, ledgerRecord, now } from './runtime-test-fixtures.js';

function pendingAllocation() {
  const ledger = ledgerRecord().ledger;
  const manifest = allocationPod(config, ledger);
  const pod = kubernetes.podSchema.parse({
    ...manifest,
    metadata: { ...manifest.metadata, uid: 'pod-test', resourceVersion: '1' },
    status: { phase: 'Pending' },
  });
  return { record: ledgerRecord(queueReport(pinPod(ledger, pod), 'pending', now)), pod };
}

function completedAllocation() {
  const stopped = requestStop(ledgerRecord().ledger, 'user_stop', now);
  const reported = queueReport(
    {
      ...stopped,
      termination: terminationEvidence(stopped, null),
      cleanupComplete: true,
    },
    'terminal',
    now
  );
  const ids = new Set(reported.reports.map(report => report.id));
  return ledgerRecord(acknowledgeReports(reported, ids, ids, now + 1000));
}

async function runProvisioner(input: {
  record: LedgerRecord;
  pod?: kubernetes.Pod;
  startAt?: number;
  turns?: number;
  loseDeletion?: boolean;
  delivery: (request: OnPremExchangeRequest, time: number) => Partial<OnPremExchangeResponse>;
}) {
  let time = input.startAt ?? now;
  let turn = 0;
  let resourceVersion = 10;
  let failConfirmation = false;
  const controller = new AbortController();
  const ledgerPath = kubernetes.namespacedPath(
    config.systemNamespace,
    'configmaps',
    input.record.resource.metadata.name
  );
  const resources = new Map<string, unknown>([[ledgerPath, input.record.resource]]);
  const identityPath = kubernetes.namespacedPath(
    config.systemNamespace,
    'secrets',
    kubernetes.IDENTITY_SECRET
  );
  resources.set(identityPath, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: kubernetes.IDENTITY_SECRET,
      namespace: config.systemNamespace,
      uid: 'identity-test',
      resourceVersion: '1',
      labels: kubernetes.ownedLabels(config.installationId, 'identity'),
    },
    data: {
      managementCredential: Buffer.from('a'.repeat(43)).toString('base64'),
      enrolled: Buffer.from('true').toString('base64'),
    },
  });
  if (input.pod)
    resources.set(
      kubernetes.namespacedPath(config.sandboxNamespace, 'pods', input.pod.metadata.name),
      input.pod
    );
  const deletions: string[] = [];
  let podCreations = 0;
  const revoked: string[] = [];
  const kube: kubernetes.KubernetesClient = {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
      if (path === ledgerPath && failConfirmation) {
        failConfirmation = false;
        throw new kubernetes.KubernetesError(0);
      }
      const [base, query] = path.split('?');
      if (query) {
        const items = [...resources.entries()]
          .filter(([key]) => key.startsWith(`${base}/`))
          .map(([, value]) => value);
        return schema.parse({
          apiVersion: 'v1',
          kind: base.endsWith('/pods') ? 'PodList' : 'ConfigMapList',
          metadata: { resourceVersion: String(resourceVersion), continue: '' },
          items,
        });
      }
      const resource = resources.get(path);
      return resource ? schema.parse(resource) : null;
    },
    async create<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
      if (path.endsWith('selfsubjectaccessreviews'))
        return schema.parse({ status: { allowed: false } });
      const resource = body as LedgerRecord['resource'];
      if (path.endsWith('/pods')) podCreations++;
      const saved = {
        ...resource,
        metadata: {
          ...resource.metadata,
          uid: 'created-test',
          resourceVersion: String(++resourceVersion),
        },
      };
      resources.set(`${path}/${resource.metadata.name}`, saved);
      return schema.parse(saved);
    },
    async replace<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
      const resource = body as LedgerRecord['resource'];
      const previous = resources.get(path) as LedgerRecord['resource'] | undefined;
      if (!previous || previous.metadata.resourceVersion !== resource.metadata.resourceVersion)
        throw new kubernetes.KubernetesError(409);
      const saved = {
        ...resource,
        metadata: { ...resource.metadata, resourceVersion: String(++resourceVersion) },
      };
      resources.set(path, saved);
      return schema.parse(saved);
    },
    async patch<T>(path: string, _body: unknown, schema: z.ZodType<T>): Promise<T> {
      const pod = kubernetes.podSchema.parse(resources.get(path));
      if (!pod.metadata.deletionTimestamp) throw new Error('unexpected_test_patch');
      resources.delete(path);
      return schema.parse({ ...pod, metadata: { ...pod.metadata, finalizers: [] } });
    },
    async remove(path, uid, _grace, version) {
      const resource = resources.get(path) as LedgerRecord['resource'] | undefined;
      if (
        resource &&
        (uid !== resource.metadata.uid ||
          (version && version !== resource.metadata.resourceVersion))
      )
        throw new kubernetes.KubernetesError(409);
      deletions.push(path);
      if (path.includes('/pods/') && resource) {
        resources.set(path, {
          ...resource,
          metadata: { ...resource.metadata, deletionTimestamp: new Date(time).toISOString() },
        });
      } else {
        resources.delete(path);
      }
      if (path === ledgerPath && input.loseDeletion) {
        failConfirmation = true;
        throw new kubernetes.KubernetesError(0);
      }
    },
  };
  const client = spyOn(kubernetes, 'createKubernetesClient').mockReturnValue(kube);
  const clock = spyOn(Date, 'now').mockImplementation(() => time);
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    time += 1000;
    if (++turn >= (input.turns ?? 6)) controller.abort();
  });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    expect(url instanceof Request ? url.url : url.toString()).toBe(
      `${config.cloudUrl}/onprem/organizations/${config.organizationId}/installations/${config.installationId}/exchange`
    );
    if (typeof init?.body !== 'string') throw new Error('unexpected_test_body');
    const request = onPremExchangeRequestSchema.parse(JSON.parse(init.body));
    return Response.json({
      protocolVersion: 1,
      serverTime: time,
      revoked: false,
      pollAfterMs: 1000,
      acknowledgedReportIds: [],
      operations: [],
      ...input.delivery(request, time),
    });
  }) as typeof globalThis.fetch);
  try {
    const provisioner = await createProvisioner(config, ref => {
      revoked.push(ref);
    });
    await provisioner.run(controller.signal);
    const resource = resources.get(ledgerPath) as LedgerRecord['resource'] | undefined;
    return {
      ledger: resource
        ? ledgerSchema.parse(JSON.parse(resource.data?.['ledger.json'] ?? 'null'))
        : null,
      health: provisioner.health(),
      deletions,
      podCreations,
      revoked,
    };
  } finally {
    fetch.mockRestore();
    sleep.mockRestore();
    clock.mockRestore();
    client.mockRestore();
  }
}

describe('exchange clock ordering', () => {
  test.each([-1, 1])(
    'rejects %s-direction skew before report acknowledgements or launches',
    async direction => {
      const pending = pendingAllocation();
      const result = await runProvisioner({
        ...pending,
        delivery: (request, time) => ({
          serverTime: time + direction * (ON_PREM_CLOCK_SKEW_MS + 1),
          acknowledgedReportIds: request.reports.map(report => report.id),
          operations: [launch],
        }),
      });
      expect(result.ledger?.registered).toBe(false);
      expect(result.ledger?.stop).toBeNull();
      expect(result.ledger?.reports.length).toBeGreaterThan(0);
      expect(result.podCreations).toBe(0);
      expect(result.health.diagnosticCode).toBe('clock_skew');
    }
  );

  test('accepts a sent pending registration at the shared clock boundary', async () => {
    const result = await runProvisioner({
      ...pendingAllocation(),
      delivery: (request, time) => ({
        serverTime: time + ON_PREM_CLOCK_SKEW_MS,
        acknowledgedReportIds: request.reports.map(report => report.id),
      }),
    });
    expect(result.ledger?.registered).toBe(true);
    expect(result.ledger?.stop).toBeNull();
  });

  test.each(['stop', 'revocation'])(
    'applies %s even when the exchange clock is rejected',
    async action => {
      const result = await runProvisioner({
        ...pendingAllocation(),
        delivery: (request, time) => ({
          serverTime: time + ON_PREM_CLOCK_SKEW_MS + 1,
          acknowledgedReportIds: request.reports.map(report => report.id),
          revoked: action === 'revocation',
          operations:
            action === 'stop'
              ? [
                  {
                    id: '66666666-6666-4666-8666-666666666666',
                    allocationId: launch.allocationId,
                    providerRef: launch.providerRef,
                    sandboxId: launch.sandboxId,
                    type: 'stop',
                    revision: 2,
                    reason: 'user_stop',
                  },
                ]
              : [],
        }),
      });
      expect(result.ledger?.stop?.reason).toBe(
        action === 'stop' ? 'user_stop' : 'installation_revoked'
      );
      expect(result.ledger?.registered).toBe(false);
      expect(result.ledger?.cleanupComplete).toBe(true);
      expect(result.ledger?.terminalReportAcknowledgedAt).toBeNull();
      expect(result.revoked).toContain(launch.providerRef);
    }
  );
});

describe('retirement discovery integration', () => {
  const boundary = launch.hardStopAt + ON_PREM_ALLOCATION_REPLAY_WINDOW_MS + ON_PREM_CLOCK_SKEW_MS;

  test('recovers a lost deletion and failed confirmation without ledger_missing on the next discovery', async () => {
    const result = await runProvisioner({
      record: completedAllocation(),
      startAt: boundary,
      turns: 40,
      loseDeletion: true,
      delivery: () => ({}),
    });
    expect(result.ledger).toBeNull();
    expect(result.deletions).toHaveLength(1);
    expect(result.health.diagnosticCode).not.toBe('local_state_unavailable');
  });

  test('does not prune from a fast local clock when cloud time is rejected', async () => {
    const result = await runProvisioner({
      record: completedAllocation(),
      startAt: boundary,
      turns: 40,
      delivery: (_request, time) => ({ serverTime: time - ON_PREM_CLOCK_SKEW_MS - 1 }),
    });
    expect(result.ledger).not.toBeNull();
    expect(result.deletions).toHaveLength(0);
  });

  test('retains legacy cleaned history without inventing acknowledgement time or refilling the outbox', async () => {
    const record = completedAllocation();
    const stored = JSON.parse(record.resource.data?.['ledger.json'] ?? 'null') as Record<
      string,
      unknown
    >;
    delete stored.terminalReportAcknowledgedAt;
    record.resource.data = { 'ledger.json': JSON.stringify(stored) };
    const result = await runProvisioner({
      record,
      startAt: boundary,
      turns: 40,
      delivery: request => ({ acknowledgedReportIds: request.reports.map(report => report.id) }),
    });
    expect(result.ledger?.terminalReportAcknowledgedAt).toBeNull();
    expect(result.ledger?.reports).toEqual([]);
    expect(result.deletions).toHaveLength(0);
  });

  test('persists a new terminal acknowledgement using the later local or validated cloud time', async () => {
    const record = ledgerRecord(
      queueReport(
        { ...completedAllocation().ledger, terminalReportAcknowledgedAt: null },
        'terminal',
        now
      )
    );
    const result = await runProvisioner({
      record,
      startAt: boundary,
      turns: 40,
      delivery: (request, time) => ({
        serverTime: time + ON_PREM_CLOCK_SKEW_MS,
        acknowledgedReportIds: request.reports.map(report => report.id),
      }),
    });
    expect(result.ledger?.terminalReportAcknowledgedAt).toBeGreaterThanOrEqual(
      boundary + ON_PREM_CLOCK_SKEW_MS
    );
    expect(result.ledger?.reports).toEqual([]);
    expect(result.deletions).toHaveLength(0);
  });

  test('a delayed launch after confirmed pruning remains stopped', async () => {
    const result = await runProvisioner({
      record: completedAllocation(),
      startAt: boundary,
      turns: 40,
      delivery: (_request, time) => ({ operations: time > boundary + 35_000 ? [launch] : [] }),
    });
    expect(result.deletions).toHaveLength(1);
    expect(result.ledger?.stop?.reason).toBe('launch_expired');
    expect(result.ledger?.createRequested).toBe(false);
    expect(result.podCreations).toBe(0);
    expect(result.health.diagnosticCode).not.toBe('local_state_unavailable');
  });
});
