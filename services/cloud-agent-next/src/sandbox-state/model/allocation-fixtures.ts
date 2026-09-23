/**
 * Canonical allocation fixtures for tests (plan rev 10.5: the flat fixture
 * builders migrate to canonical in C3b).
 *
 * This mirrors `convertLegacyAllocation`'s canonical target, but takes an
 * explicit descriptor instead of a legacy record, so tests can build the
 * canonical aggregate without importing the frozen legacy decoder (which is
 * quarantined to `persist/load.ts`).
 */
import {
  type AllocationCreateIntent,
  type AllocationRecord,
  type AllocationTarget,
  type CredentialContainmentRequirements,
  type OnPremAllocationConfig,
  type VercelAllocationConfig,
} from './allocation.js';
import { connectingHealth } from './health.js';
import { POLICY } from '../schedule.js';

export type AllocationFixtureContainment = CredentialContainmentRequirements & {
  providerRef: string;
};

export type AllocationFixture = {
  state: 'stopped' | 'creating' | 'running' | 'stopping' | 'failed' | 'unknown';
  /** Overrides the provider inferred from `createIntent.vercel`/`onprem`. */
  provider?: 'cloudflare' | 'vercel' | 'onprem';
  providerRef?: string | null;
  createIntent?: {
    intentId: string;
    createdAt: number;
    allocationName?: string;
    vercel?: VercelAllocationConfig;
    onprem?: OnPremAllocationConfig;
    containment?: CredentialContainmentRequirements;
  } | null;
  stopTombstone?: {
    reason: string;
    attempts: number;
    createdAt: number;
    wrapperInstanceId?: string;
  } | null;
  resumable?: boolean;
  containment?: AllocationFixtureContainment;
  /** Allocated health shape; defaults to `connecting`. */
  health?: 'connecting' | 'healthy';
  /** Heartbeat instant for `health: 'healthy'`; defaults to the create instant. */
  heartbeatAt?: number;
  /** Canonical idle anchor for an allocated record. */
  idleAt?: number | null;
};

const CLOUDFLARE_CAPABILITIES = { persistentWorkspace: false, destroysOnStop: true } as const;
const VERCEL_CAPABILITIES = { persistentWorkspace: true, destroysOnStop: false } as const;

function targetFor(fixture: AllocationFixture): AllocationTarget {
  const intent = fixture.createIntent ?? null;
  const vercel = intent?.vercel;
  const onprem = intent?.onprem;
  const provider = fixture.provider ?? (onprem ? 'onprem' : vercel ? 'vercel' : 'cloudflare');
  const target: AllocationTarget = {
    provider,
    providerRef: fixture.providerRef ?? null,
    capabilities: provider === 'vercel' ? VERCEL_CAPABILITIES : CLOUDFLARE_CAPABILITIES,
  };
  if (intent?.allocationName !== undefined) target.allocationName = intent.allocationName;
  if (vercel !== undefined) target.vercel = vercel;
  if (onprem !== undefined) target.onprem = onprem;
  if (intent?.containment !== undefined) target.containment = intent.containment;
  if (fixture.containment !== undefined) target.resolvedContainment = fixture.containment;
  return target;
}

function createIntentFor(fixture: AllocationFixture): AllocationCreateIntent | null {
  const intent = fixture.createIntent;
  if (!intent) return null;
  return { intentId: intent.intentId, createdAt: intent.createdAt };
}

function healthyHealth(incarnation: string, heartbeatAt: number) {
  return {
    kind: 'healthy' as const,
    incarnation,
    lastHeartbeat: { incarnation, at: heartbeatAt, ready: true },
    deadlineAt: heartbeatAt + POLICY.heartbeatExpiryMs,
  };
}

/**
 * Builds the canonical aggregate for a descriptor. Returns `undefined` when the
 * descriptor has no representable canonical state (for example `running`
 * without a create intent), matching the legacy converter's fail-closed rule.
 */
export function allocationFixture(fixture: AllocationFixture): AllocationRecord | undefined {
  const target = targetFor(fixture);
  const intent = createIntentFor(fixture);
  const resumable = fixture.resumable === true;
  const tombstone = fixture.stopTombstone ?? null;

  switch (fixture.state) {
    case 'stopped': {
      const summary =
        fixture.providerRef || target.allocationName !== undefined
          ? {
              providerRef: fixture.providerRef ?? null,
              ...(target.allocationName !== undefined
                ? { allocationName: target.allocationName }
                : {}),
            }
          : null;
      return { v: 2, resumable, state: { kind: 'stopped', summary } };
    }
    case 'creating': {
      if (!intent) return undefined;
      return {
        v: 2,
        resumable,
        state: {
          kind: 'creating',
          requestId: intent.intentId,
          target,
          createIntent: intent,
          attempt: 0,
          deadlineAt: intent.createdAt + POLICY.createDeadlineMs,
        },
      };
    }
    case 'running': {
      if (!intent) return undefined;
      const incarnation = fixture.providerRef ?? intent.intentId;
      const health =
        fixture.health === 'healthy'
          ? healthyHealth(incarnation, fixture.heartbeatAt ?? intent.createdAt)
          : connectingHealth(incarnation, intent.createdAt + POLICY.connectingDeadlineMs);
      return {
        v: 2,
        resumable,
        state: {
          kind: 'allocated',
          target,
          createIntent: intent,
          health,
          idleAt: fixture.idleAt ?? null,
        },
      };
    }
    case 'stopping': {
      if (!intent) return undefined;
      const createdAt = tombstone?.createdAt ?? intent.createdAt;
      return {
        v: 2,
        resumable,
        state: {
          kind: 'stopping',
          target,
          createIntent: intent,
          stopIntent: {
            reason: tombstone?.reason ?? 'legacy_stopping',
            createdAt,
            ...(tombstone?.wrapperInstanceId !== undefined
              ? { wrapperInstanceId: tombstone.wrapperInstanceId }
              : {}),
          },
          step: 'destroying',
          attempts: tombstone?.attempts ?? 0,
          deadlineAt: createdAt + POLICY.stopDeadlineMs,
        },
      };
    }
    case 'failed':
    case 'unknown': {
      const from = intent?.createdAt ?? tombstone?.createdAt ?? 0;
      return {
        v: 2,
        resumable,
        state: {
          kind: 'unknown',
          target,
          createIntent: intent,
          stopIntent: tombstone
            ? {
                reason: tombstone.reason,
                createdAt: tombstone.createdAt,
                ...(tombstone.wrapperInstanceId !== undefined
                  ? { wrapperInstanceId: tombstone.wrapperInstanceId }
                  : {}),
              }
            : null,
          attempts: tombstone?.attempts ?? 0,
          reason: fixture.state === 'failed' ? 'legacy_failed' : 'legacy_unknown',
          deadlineAt: from + POLICY.observeDeadlineMs,
        },
      };
    }
  }
}
