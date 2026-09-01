import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';

export type PhysicalState = 'stopped' | 'creating' | 'running' | 'stopping' | 'failed' | 'unknown';

export type CredentialContainmentRequirements = {
  kilocode: boolean;
  github: boolean;
  worktreeScoped?: true;
};

export const WORKTREE_CREDENTIAL_CONTAINMENT = {
  kilocode: true,
  github: true,
  worktreeScoped: true,
} satisfies CredentialContainmentRequirements;

export type CreateIntent = {
  intentId: string;
  createdAt: number;
  allocationName?: string;
  vercel?: Pick<
    VercelSandboxRuntimeConfig,
    'projectId' | 'snapshotId' | 'runtimeBuildId' | 'runtime'
  >;
  containment?: CredentialContainmentRequirements;
};

export type StopTombstone = {
  reason: string;
  attempts: number;
  createdAt: number;
  wrapperInstanceId?: string;
};

export type PhysicalRecord = {
  state: PhysicalState;
  providerRef: string | null;
  createIntent: CreateIntent | null;
  stopTombstone: StopTombstone | null;
  resumable: boolean;
  containment?: CredentialContainmentRequirements & { providerRef: string };
};

export type ObserveResult = 'active' | 'terminal' | 'unknown';

export function initialPhysicalRecord(resumable: boolean): PhysicalRecord {
  return {
    state: 'stopped',
    providerRef: null,
    createIntent: null,
    stopTombstone: null,
    resumable,
  };
}

export function claimCreate(
  record: PhysicalRecord,
  intentId: string,
  now: number,
  allocationName?: string,
  containment?: CredentialContainmentRequirements
): PhysicalRecord {
  if (record.state !== 'stopped') {
    throw illegal('claimCreate', record.state);
  }
  return {
    ...record,
    state: 'creating',
    createIntent: {
      intentId,
      createdAt: now,
      ...(allocationName ? { allocationName } : {}),
      ...(containment
        ? {
            containment: {
              kilocode: containment.kilocode,
              github: containment.github,
              ...(containment.worktreeScoped ? { worktreeScoped: true } : {}),
            },
          }
        : {}),
    },
  };
}

export function confirmRunning(
  record: PhysicalRecord,
  providerRef: string,
  _now: number
): PhysicalRecord {
  if (record.state === 'running') {
    if (record.providerRef === providerRef) return record;
    throw illegal('confirmRunning', record.state);
  }
  if (record.state !== 'creating') {
    throw illegal('confirmRunning', record.state);
  }
  return toRunning(record, providerRef);
}

export function beginStop(
  record: PhysicalRecord,
  reason: string,
  now: number,
  wrapperInstanceId?: string
): PhysicalRecord {
  if (record.state === 'stopped' || (record.providerRef === null && record.createIntent === null)) {
    throw illegal('beginStop', record.state);
  }
  return {
    ...record,
    state: 'stopping',
    stopTombstone: record.stopTombstone ?? {
      reason,
      attempts: 0,
      createdAt: now,
      ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
    },
  };
}

export function recordStopAttempt(record: PhysicalRecord): PhysicalRecord {
  if (record.state !== 'stopping' || record.stopTombstone === null) {
    throw illegal('recordStopAttempt', record.state);
  }
  return {
    ...record,
    stopTombstone: {
      ...record.stopTombstone,
      attempts: record.stopTombstone.attempts + 1,
    },
  };
}

export function confirmStopped(record: PhysicalRecord): PhysicalRecord {
  if (
    record.state !== 'creating' &&
    record.state !== 'stopping' &&
    record.state !== 'failed' &&
    record.state !== 'unknown'
  ) {
    throw illegal('confirmStopped', record.state);
  }
  return toStopped(record);
}

export function observe(record: PhysicalRecord, result: ObserveResult): PhysicalRecord {
  switch (record.state) {
    case 'stopped':
      throw illegal('observe', record.state);
    case 'creating':
      if (result === 'active') {
        if (record.providerRef === null) return record;
        return toRunning(record, record.providerRef);
      }
      if (result === 'terminal') return toStopped(record);
      return record;
    case 'running':
      if (result === 'active') return record;
      if (result === 'terminal') return toFailed(record);
      return toUnknown(record);
    case 'stopping':
      if (result === 'terminal') return toStopped(record);
      return record;
    case 'failed':
      if (result === 'terminal') return toStopped(record);
      return toUnknown(record);
    case 'unknown':
      if (result === 'terminal') return toStopped(record);
      if (result === 'active' && record.stopTombstone === null) {
        if (record.providerRef === null) return record;
        return toRunning(record, record.providerRef);
      }
      return record;
  }
}

export function fail(record: PhysicalRecord, now: number): PhysicalRecord {
  if (record.state !== 'creating' && record.state !== 'running') {
    throw illegal('fail', record.state);
  }
  return {
    ...toFailed(record),
    stopTombstone: record.stopTombstone ?? {
      reason: 'environment_failed',
      attempts: 0,
      createdAt: now,
    },
  };
}

export function sameAllocation(left: PhysicalRecord, right: PhysicalRecord): boolean {
  if (left.createIntent || right.createIntent) {
    return left.createIntent?.intentId === right.createIntent?.intentId;
  }
  return left.providerRef !== null && left.providerRef === right.providerRef;
}

export function exhaustStopRetries(record: PhysicalRecord): PhysicalRecord {
  if (record.state !== 'stopping') {
    throw illegal('exhaustStopRetries', record.state);
  }
  return toUnknown(record);
}

function toRunning(record: PhysicalRecord, providerRef: string): PhysicalRecord {
  const containment = record.createIntent?.containment;
  return {
    ...record,
    state: 'running',
    providerRef,
    ...(containment
      ? {
          containment: {
            kilocode: containment.kilocode,
            github: containment.github,
            ...(containment.worktreeScoped ? { worktreeScoped: true } : {}),
            providerRef,
          },
        }
      : {}),
  };
}

function toFailed(record: PhysicalRecord): PhysicalRecord {
  return { ...record, state: 'failed' };
}

function toUnknown(record: PhysicalRecord): PhysicalRecord {
  return { ...record, state: 'unknown' };
}

function toStopped(record: PhysicalRecord): PhysicalRecord {
  return {
    state: 'stopped',
    providerRef: null,
    createIntent: null,
    stopTombstone: null,
    resumable: record.resumable,
  };
}

function illegal(operation: string, state: PhysicalState): Error {
  return new Error(`${operation} from ${state}`);
}
