import type { z } from 'zod';
import {
  ON_PREM_ALLOCATION_REPLAY_WINDOW_MS,
  ON_PREM_CLOCK_SKEW_MS,
  ON_PREM_MAX_LIFETIME_MS,
} from '../../src/shared/onprem-protocol.js';
import {
  KubernetesError,
  bootstrapName,
  configMapSchema,
  isOwned,
  ledgerName,
  namespacedPath,
  podName,
  podSchema,
  secretSchema,
  type KubernetesClient,
  type OnPremConfig,
} from './kubernetes.js';
import { type AllocationLedger } from './ledger.js';

export type LedgerRecord = {
  resource: z.infer<typeof configMapSchema>;
  ledger: AllocationLedger;
};

export function canRetireLedger(ledger: AllocationLedger, now: number): boolean {
  if (
    !ledger.cleanupComplete ||
    !ledger.stop ||
    !ledger.termination ||
    ledger.terminalReportAcknowledgedAt === null ||
    ledger.reports.length !== 0 ||
    ledger.lastReport?.status !== 'terminal' ||
    ledger.lastReport.revision !== ledger.revision ||
    ledger.lastReport.observedAt !== ledger.termination.observedAt
  )
    return false;
  return (
    now >=
    Math.max(
      ledger.launch?.hardStopAt ?? ledger.terminalReportAcknowledgedAt + ON_PREM_MAX_LIFETIME_MS,
      ledger.launch?.notAfter ?? 0,
      ledger.stop.requestedAt,
      ledger.termination.observedAt,
      ledger.terminalReportAcknowledgedAt
    ) +
      ON_PREM_ALLOCATION_REPLAY_WINDOW_MS +
      ON_PREM_CLOCK_SKEW_MS
  );
}

export function createLedgerRetention(
  kube: Pick<KubernetesClient, 'get' | 'remove'>,
  config: Pick<
    OnPremConfig,
    'organizationId' | 'installationId' | 'systemNamespace' | 'sandboxNamespace'
  >
) {
  const pending = new Map<string, { uid: string; resourceVersion: string }>();

  function isPending(record: LedgerRecord): boolean {
    const expected = pending.get(record.ledger.allocationId);
    return (
      expected?.uid === record.resource.metadata.uid &&
      expected?.resourceVersion === record.resource.metadata.resourceVersion
    );
  }

  async function retire(record: LedgerRecord, now: number): Promise<boolean> {
    const { ledger, resource } = record;
    const { metadata } = resource;
    if (!canRetireLedger(ledger, now)) return false;
    if (
      ledger.organizationId !== config.organizationId ||
      ledger.installationId !== config.installationId ||
      metadata.namespace !== config.systemNamespace ||
      metadata.name !== ledgerName(ledger.allocationId) ||
      !isOwned(metadata, config.installationId, 'ledger', ledger.allocationId)
    )
      throw new Error('ledger_owner_mismatch');
    if (metadata.deletionTimestamp || metadata.finalizers?.length) return false;
    const [pod, secret] = await Promise.all([
      kube.get(
        namespacedPath(config.sandboxNamespace, 'pods', podName(ledger.allocationId)),
        podSchema
      ),
      kube.get(
        namespacedPath(config.sandboxNamespace, 'secrets', bootstrapName(ledger.allocationId)),
        secretSchema
      ),
    ]);
    if (pod || secret) return false;
    const path = namespacedPath(config.systemNamespace, 'configmaps', metadata.name);
    pending.set(ledger.allocationId, {
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
    });
    try {
      await kube.remove(path, metadata.uid, 0, metadata.resourceVersion);
    } catch (error) {
      if (error instanceof KubernetesError && error.status >= 400 && error.status < 500) {
        pending.delete(ledger.allocationId);
        throw error;
      }
      const remaining = await kube.get(path, configMapSchema);
      if (!remaining) return true;
      if (!isPending({ ...record, resource: remaining })) pending.delete(ledger.allocationId);
      throw error;
    }
    const remaining = await kube.get(path, configMapSchema);
    if (!remaining) return true;
    if (!isPending({ ...record, resource: remaining })) pending.delete(ledger.allocationId);
    return false;
  }

  return { retire, isPending, forget: (allocationId: string) => pending.delete(allocationId) };
}
