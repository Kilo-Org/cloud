import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decodeOnPremProviderRef,
  onPremOperationSchema,
  onPremReportSchema,
  type OnPremOperation,
  type OnPremReport,
} from '../../src/shared/onprem-protocol.js';
import { containersTerminated, neverScheduled, type OnPremConfig, type Pod } from './kubernetes.js';

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codeSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
const receiptSchema = z
  .object({
    id: z.uuid(),
    revision: timestampSchema,
    type: z.enum(['launch', 'stop']),
    digest: digestSchema,
  })
  .strict();

function withoutRegistrationReports(reports: OnPremReport[]): OnPremReport[] {
  return reports.filter(report => report.status !== 'pending');
}

export const ledgerSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    installationId: z.uuid(),
    allocationId: z.uuid(),
    sandboxId: z.string().min(1).max(256),
    providerRef: z.string().refine(value => decodeOnPremProviderRef(value) !== null),
    revision: timestampSchema,
    receipts: z.array(receiptSchema).max(16),
    launch: z
      .object({
        operationId: z.uuid(),
        revision: timestampSchema,
        digest: digestSchema,
        profileId: z.string(),
        profileRevision: z.string(),
        policyDigest: digestSchema,
        hardStopAt: timestampSchema,
        notAfter: timestampSchema,
        activeDeadlineSeconds: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    stop: z.object({ reason: codeSchema, requestedAt: timestampSchema }).strict().nullable(),
    createRequested: z.boolean(),
    pod: onPremReportSchema.shape.pod.unwrap().nullable(),
    bootstrapUid: z.string().min(1).nullable(),
    gate: z.enum(['closed', 'opening', 'open']),
    registrationReportId: z.uuid().nullable(),
    registered: z.boolean(),
    termination: z
      .object({
        observedAt: timestampSchema,
        evidence: z.enum(['never_created', 'never_scheduled', 'containers_terminated']),
      })
      .strict()
      .nullable(),
    cleanupComplete: z.boolean(),
    terminalReportAcknowledgedAt: timestampSchema.nullable().default(null),
    reports: z.array(onPremReportSchema).max(8),
    lastReport: onPremReportSchema.nullable(),
  })
  .strict()
  .refine(value => {
    const ref = decodeOnPremProviderRef(value.providerRef);
    return ref?.installationId === value.installationId && ref.allocationId === value.allocationId;
  })
  .refine(value => !value.registered || (value.pod !== null && value.registrationReportId !== null))
  .refine(value => !value.pod || value.createRequested)
  .refine(value => !value.termination || value.stop !== null)
  .refine(value => !value.cleanupComplete || value.termination !== null)
  .transform(value =>
    value.stop ? { ...value, reports: withoutRegistrationReports(value.reports) } : value
  );

export type AllocationLedger = z.infer<typeof ledgerSchema>;
export type LaunchOperation = Extract<OnPremOperation, { type: 'launch' }>;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function operationDigest(operation: OnPremOperation): string {
  const parsed = onPremOperationSchema.parse(operation);
  return sha256(
    JSON.stringify(
      parsed.type === 'launch'
        ? {
            ...parsed,
            bootstrap: Object.fromEntries(
              Object.entries(parsed.bootstrap).sort(([left], [right]) => left.localeCompare(right))
            ),
          }
        : parsed
    )
  );
}

export function policyDigest(config: OnPremConfig): string {
  return sha256(
    JSON.stringify({
      profile: config.profile,
      systemNamespace: config.systemNamespace,
      sandboxNamespace: config.sandboxNamespace,
      brokerClusterIp: config.brokerClusterIp,
      cloudUrl: config.cloudUrl,
      cloudIPv4: config.cloudIPv4,
      dnsIPv4: config.dnsIPv4,
      resources: config.resources,
      upstreams: config.upstreams,
      localFixtureUpstreams: config.localFixtureUpstreams,
    })
  );
}

export function newLedger(operation: OnPremOperation, config: OnPremConfig): AllocationLedger {
  return {
    version: 1,
    organizationId: config.organizationId,
    installationId: config.installationId,
    allocationId: operation.allocationId,
    sandboxId: operation.sandboxId,
    providerRef: operation.providerRef,
    revision: operation.revision,
    receipts: [],
    launch: null,
    stop: null,
    createRequested: false,
    pod: null,
    bootstrapUid: null,
    gate: 'closed',
    registrationReportId: null,
    registered: false,
    termination: null,
    cleanupComplete: false,
    terminalReportAcknowledgedAt: null,
    reports: [],
    lastReport: null,
  };
}

export function requestStop(
  ledger: AllocationLedger,
  reason: string,
  now: number
): AllocationLedger {
  const reports = withoutRegistrationReports(ledger.reports);
  if (ledger.stop && reports.length === ledger.reports.length) return ledger;
  return {
    ...ledger,
    stop: ledger.stop ?? { reason: codeSchema.parse(reason), requestedAt: now },
    reports,
  };
}

export function approvedBootstrap(
  operation: LaunchOperation,
  config: OnPremConfig
): Record<string, string> {
  const controlUrl = new URL(
    `/sandbox-control/${encodeURIComponent(operation.sandboxId)}`,
    config.cloudUrl
  );
  controlUrl.protocol = controlUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const bootstrap = operation.bootstrap;
  if (
    bootstrap.SANDBOX_CONTROL_URL !== controlUrl.toString() ||
    !bootstrap.SANDBOX_CONTROL_CREDENTIAL ||
    bootstrap.PROVIDER_INSTANCE_ID !== operation.providerRef ||
    bootstrap.KILO_PLATFORM !== 'cloud-agent' ||
    bootstrap.KILO_DISABLE_AUTOUPDATE !== 'true' ||
    !['0', '1'].includes(bootstrap.KILO_DEBUG_SESSION_INGEST ?? '')
  )
    throw new Error('bootstrap_not_approved');
  return {
    SANDBOX_CONTROL_URL: bootstrap.SANDBOX_CONTROL_URL,
    SANDBOX_CONTROL_CREDENTIAL: bootstrap.SANDBOX_CONTROL_CREDENTIAL,
    PROVIDER_INSTANCE_ID: operation.providerRef,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: bootstrap.KILO_DEBUG_SESSION_INGEST,
  };
}

export function acceptOperation(
  existing: AllocationLedger | null,
  operation: OnPremOperation,
  config: OnPremConfig,
  now: number
): AllocationLedger {
  if (decodeOnPremProviderRef(operation.providerRef)?.installationId !== config.installationId)
    throw new Error('installation_mismatch');
  let ledger = existing ?? newLedger(operation, config);
  if (
    ledger.organizationId !== config.organizationId ||
    ledger.installationId !== config.installationId ||
    ledger.allocationId !== operation.allocationId
  )
    throw new Error('ledger_owner_mismatch');
  ledger = { ...ledger, revision: Math.max(ledger.revision, operation.revision) };
  if (ledger.sandboxId !== operation.sandboxId || ledger.providerRef !== operation.providerRef)
    return requestStop(ledger, 'operation_conflict', now);
  const digest = operationDigest(operation);
  const receipt = ledger.receipts.find(item => item.id === operation.id);
  if (receipt && receipt.digest !== digest) return requestStop(ledger, 'operation_conflict', now);
  if (!receipt) {
    if (ledger.receipts.length >= 16) return requestStop(ledger, 'receipt_limit', now);
    ledger = {
      ...ledger,
      receipts: [
        ...ledger.receipts,
        { id: operation.id, revision: operation.revision, type: operation.type, digest },
      ],
    };
  }
  if (operation.type === 'stop') return requestStop(ledger, operation.reason, now);
  if (ledger.stop || ledger.termination) return ledger;
  if (ledger.launch) {
    if (ledger.launch.digest !== digest || ledger.launch.policyDigest !== policyDigest(config))
      return requestStop(ledger, 'launch_conflict', now);
    return ledger;
  }
  if (
    operation.profileId !== config.profile.id ||
    operation.profileRevision !== config.profile.revision
  )
    return requestStop(ledger, 'profile_not_approved', now);
  if (operation.notAfter <= now || operation.hardStopAt <= now)
    return requestStop(ledger, 'launch_expired', now);
  if (
    operation.notAfter > operation.hardStopAt ||
    operation.notAfter > now + 120_000 ||
    operation.hardStopAt > now + config.profile.maxLifetimeMs
  )
    return requestStop(ledger, 'lifetime_not_approved', now);
  try {
    approvedBootstrap(operation, config);
  } catch {
    return requestStop(ledger, 'bootstrap_not_approved', now);
  }
  return {
    ...ledger,
    launch: {
      operationId: operation.id,
      revision: operation.revision,
      digest,
      profileId: operation.profileId,
      profileRevision: operation.profileRevision,
      policyDigest: policyDigest(config),
      hardStopAt: operation.hardStopAt,
      notAfter: operation.notAfter,
      activeDeadlineSeconds: Math.max(1, Math.floor((operation.hardStopAt - now) / 1000)),
    },
  };
}

export function pinPod(ledger: AllocationLedger, pod: Pod): AllocationLedger {
  if (
    ledger.pod &&
    (ledger.pod.uid !== pod.metadata.uid ||
      ledger.pod.name !== pod.metadata.name ||
      ledger.pod.namespace !== pod.metadata.namespace)
  )
    throw new Error('pod_identity_conflict');
  if (ledger.pod?.ip && pod.status?.podIP && ledger.pod.ip !== pod.status.podIP)
    throw new Error('pod_ip_conflict');
  if (!pod.metadata.namespace) throw new Error('pod_namespace_missing');
  return {
    ...ledger,
    createRequested: true,
    pod: {
      namespace: pod.metadata.namespace,
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      ...(ledger.pod?.ip || pod.status?.podIP
        ? { ip: ledger.pod?.ip || pod.status?.podIP || undefined }
        : {}),
    },
  };
}

export function terminationEvidence(
  ledger: AllocationLedger,
  pod: Pod | null
): AllocationLedger['termination'] {
  if (ledger.termination) return ledger.termination;
  if (!pod)
    return !ledger.createRequested && !ledger.pod
      ? { observedAt: ledger.stop?.requestedAt ?? 0, evidence: 'never_created' }
      : null;
  if (
    !ledger.pod ||
    ledger.pod.uid !== pod.metadata.uid ||
    ledger.pod.namespace !== pod.metadata.namespace ||
    ledger.pod.name !== pod.metadata.name
  )
    return null;
  if (containersTerminated(pod)) {
    const finishedAt = Math.max(
      ...(pod.status?.containerStatuses ?? []).map(status =>
        Date.parse(status.state.terminated?.finishedAt ?? '')
      )
    );
    return { observedAt: finishedAt, evidence: 'containers_terminated' };
  }
  if (ledger.gate === 'closed' && pod.metadata.deletionTimestamp && neverScheduled(pod)) {
    return { observedAt: Date.parse(pod.metadata.deletionTimestamp), evidence: 'never_scheduled' };
  }
  return null;
}

export function queueReport(
  ledger: AllocationLedger,
  status: OnPremReport['status'],
  observedAt: number,
  diagnosticCode?: string
): AllocationLedger {
  if (status === 'terminal' && !ledger.termination) throw new Error('termination_unconfirmed');
  const observationTime = status === 'terminal' ? ledger.termination?.observedAt : observedAt;
  const sameObservation = (report: OnPremReport) =>
    report.status === status &&
    report.revision === ledger.revision &&
    report.diagnosticCode === diagnosticCode &&
    JSON.stringify(report.pod ?? null) === JSON.stringify(ledger.pod);
  if (ledger.reports.some(sameObservation)) return ledger;
  if (ledger.reports.length >= 8) throw new Error('report_outbox_full');
  const report = onPremReportSchema.parse({
    id: crypto.randomUUID(),
    allocationId: ledger.allocationId,
    revision: ledger.revision,
    observedAt: observationTime,
    status,
    ...(ledger.pod ? { pod: ledger.pod } : {}),
    ...(diagnosticCode ? { diagnosticCode } : {}),
  });
  return {
    ...ledger,
    reports: [...ledger.reports, report],
    lastReport: report,
    registrationReportId:
      ledger.registrationReportId ??
      (status === 'pending' && ledger.pod && !ledger.stop ? report.id : null),
  };
}

export function acknowledgeReports(
  ledger: AllocationLedger,
  acknowledged: ReadonlySet<string>,
  sent: ReadonlySet<string>,
  acknowledgedAt: number
): AllocationLedger {
  const wasAcknowledged = (report: OnPremReport) =>
    acknowledged.has(report.id) && sent.has(report.id);
  const registered =
    !ledger.stop &&
    ledger.pod !== null &&
    ledger.reports.some(
      report =>
        wasAcknowledged(report) &&
        report.id === ledger.registrationReportId &&
        report.status === 'pending' &&
        report.revision === ledger.launch?.revision &&
        report.pod?.uid === ledger.pod?.uid
    );
  return {
    ...ledger,
    registered: ledger.registered || registered,
    terminalReportAcknowledgedAt: ledger.reports.some(
      report =>
        wasAcknowledged(report) &&
        report.status === 'terminal' &&
        report.revision === ledger.revision &&
        report.observedAt === ledger.termination?.observedAt &&
        JSON.stringify(report.pod ?? null) === JSON.stringify(ledger.pod)
    )
      ? Math.max(ledger.terminalReportAcknowledgedAt ?? 0, acknowledgedAt)
      : ledger.terminalReportAcknowledgedAt,
    reports: ledger.reports.filter(report => !wasAcknowledged(report)),
  };
}

export function canOpenGate(ledger: AllocationLedger, config: OnPremConfig, now: number): boolean {
  return (
    !ledger.stop &&
    !ledger.termination &&
    ledger.registered &&
    ledger.pod !== null &&
    ledger.launch !== null &&
    ledger.launch.policyDigest === policyDigest(config) &&
    ledger.launch.notAfter > now &&
    ledger.launch.hardStopAt > now
  );
}
