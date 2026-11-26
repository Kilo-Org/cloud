import {
  AuditEventSchema,
  OCSF_API_ACTIVITY,
  OCSF_CLASS,
  type AuditEvent,
  type SecretName,
  type StsEnvironment,
  type WorkloadName,
} from '@kilocode/sts-contracts';
import type { PolicySnapshotEntry } from '../policy/load';
import type { Denial } from './denials';

/** Attributes hold at most 256 values; longer lists are cut and flagged. */
function attributeList(values: string[]): { values: string[]; truncated: boolean } {
  return { values: values.slice(0, 256), truncated: values.length > 256 };
}

export function stsSource(environment: StsEnvironment): string {
  return `kilo:sts:${environment}`;
}

export function bundleDeliveredEvent(input: {
  environment: StsEnvironment;
  workload: WorkloadName;
  etag: string;
  stale: boolean;
  secrets: { name: SecretName; version: number }[];
  missing: SecretName[];
}): AuditEvent {
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.bundle.delivered',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.read,
      outcome: 'success',
      actor: { kind: 'workload', id: input.workload },
      attributes: {
        workload: input.workload,
        environment: input.environment,
        etag: input.etag,
        stale: input.stale,
        secretCount: input.secrets.length,
        secrets: input.secrets.map(secret => `${secret.name}:${secret.version}`),
        missing: [...input.missing],
      },
    },
  });
}

/**
 * `count` identical refused reads in the minute starting at `windowStart` (design 4.3: STS refuses
 * and audits any other read). `overflow` marks the row that counts denials past the per-minute
 * distinct limit; it carries no claims.
 */
export function bundleDeniedEvent(input: {
  environment: StsEnvironment;
  denial: Denial;
  count: number;
  windowStart: string;
  overflow: boolean;
}): AuditEvent {
  const claims = Object.keys(input.denial.claims)
    .sort()
    .map(name => `${name}=${input.denial.claims[name]}`.slice(0, 256));
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.bundle.denied',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.read,
      outcome: 'denied',
      outcomeDetail: input.denial.reason,
      actor: {
        kind: input.denial.channel === 'worker-binding' ? 'workload' : 'service',
        id: input.denial.actor,
      },
      attributes: {
        environment: input.environment,
        channel: input.denial.channel,
        reason: input.denial.reason,
        count: input.count,
        windowStart: input.windowStart,
        overflow: input.overflow,
        claims,
      },
    },
  });
}

/**
 * The manager returned a value in secret-reference syntax. STS kept the last good copy of that
 * one secret (or none) and records the name and version only (design 4.2).
 */
export function managerReferenceRefusedEvent(input: {
  environment: StsEnvironment;
  path: string;
  name: string;
  version: number;
  keptLastGood: boolean;
}): AuditEvent {
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.manager.reference_refused',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.read,
      outcome: 'failure',
      outcomeDetail: 'secret value uses reference syntax',
      actor: { kind: 'system', id: `sts:${input.environment}` },
      attributes: {
        environment: input.environment,
        path: input.path.slice(0, 512),
        secret: input.name.slice(0, 512),
        version: input.version,
        keptLastGood: input.keptLastGood,
      },
    },
  });
}

function secretKeys(snapshot: PolicySnapshotEntry[]): string[] {
  return snapshot.flatMap(entry => entry.secrets.map(name => `${entry.workload}:${name}`));
}

export function policyChangedEvent(input: {
  environment: StsEnvironment;
  policyHash: string;
  previousPolicyHash: string | null;
  previous: PolicySnapshotEntry[];
  current: PolicySnapshotEntry[];
}): AuditEvent {
  const previousWorkloads = new Set(input.previous.map(entry => entry.workload));
  const currentWorkloads = new Set(input.current.map(entry => entry.workload));
  const previousSecrets = new Set(secretKeys(input.previous));
  const currentSecrets = new Set(secretKeys(input.current));

  const addedWorkloads = [...currentWorkloads].filter(name => !previousWorkloads.has(name));
  const removedWorkloads = [...previousWorkloads].filter(name => !currentWorkloads.has(name));
  const addedSecrets = [...currentSecrets].filter(key => !previousSecrets.has(key));
  const removedSecrets = [...previousSecrets].filter(key => !currentSecrets.has(key));
  const added = attributeList(addedWorkloads);
  const removed = attributeList(removedWorkloads);
  const addedSecretList = attributeList(addedSecrets);
  const removedSecretList = attributeList(removedSecrets);

  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.policy.changed',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.accountChange,
      activityId: OCSF_API_ACTIVITY.update,
      outcome: 'success',
      outcomeDetail: input.previousPolicyHash === null ? 'initial policy' : 'policy changed',
      actor: { kind: 'system', id: `sts:${input.environment}` },
      attributes: {
        environment: input.environment,
        policyHash: input.policyHash,
        previousPolicyHash: input.previousPolicyHash ?? 'none',
        addedWorkloads: added.values,
        removedWorkloads: removed.values,
        addedSecrets: addedSecretList.values,
        removedSecrets: removedSecretList.values,
        workloadsTruncated: added.truncated || removed.truncated,
        secretsTruncated: addedSecretList.truncated || removedSecretList.truncated,
      },
    },
  });
}
