import { z } from 'zod';
import {
  canDestroyCloudAgentWorktreeSandboxResultSchema,
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeLocationSchema,
  sessionIdSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
  type CanDestroyCloudAgentWorktreeSandboxParams,
  type CloudAgentWorktreeLocation,
  type UnresolvedCloudAgentSandboxOwner,
} from '@kilocode/session-ingest-contracts';
import { DEFAULT_DO_RETRY_CONFIG } from '@kilocode/worker-utils';
import { getSandboxProvider, type SessionMetadata } from '../persistence/session-metadata';
import { getSandboxSessionStub, resolveSessionStub } from '../sandbox-session/session-stub';
import { sessionPlaneFromId } from '../session-plane';
import { withDORetry } from '../utils/do-retry';
import type { Env } from '../types';
import { logControlDiagnostic } from './diagnostics';

export const sessionRuntimeLocatorSchema = z
  .object({
    cloudAgentSessionId: z.string().min(1),
    kiloUserId: z.string().min(1),
    organizationId: z.uuid().nullable(),
    sessionId: sessionIdSchema.nullable(),
    worktreeId: cloudAgentWorktreeIdSchema.nullable(),
    location: cloudAgentWorktreeLocationSchema,
  })
  .strict();
export type SessionRuntimeLocator = z.infer<typeof sessionRuntimeLocatorSchema>;

export function sessionRuntimeLocator(metadata: SessionMetadata): SessionRuntimeLocator | null {
  if (!metadata.workspace?.sandboxId) return null;
  return sessionRuntimeLocatorSchema.parse({
    cloudAgentSessionId: metadata.identity.sessionId,
    kiloUserId: metadata.identity.userId,
    organizationId: metadata.identity.orgId ?? null,
    sessionId: metadata.auth.kiloSessionId ?? null,
    worktreeId: metadata.workspace.worktreeId ?? null,
    location: { sandboxId: metadata.workspace.sandboxId, provider: getSandboxProvider(metadata) },
  });
}

const RECONCILIATION_BUDGET_MS = 20_000;
const RECONCILIATION_CONCURRENCY = 8;
export const RECONCILIATION_CALL_TIMEOUT_MS = 5_000;

export type ReconciliationLimits = {
  budgetMs: number;
  concurrency: number;
  callTimeoutMs: number;
};

export const RECONCILIATION_LIMITS: ReconciliationLimits = {
  budgetMs: RECONCILIATION_BUDGET_MS,
  concurrency: RECONCILIATION_CONCURRENCY,
  callTimeoutMs: RECONCILIATION_CALL_TIMEOUT_MS,
};

export type SandboxReferenceReconciliation = {
  complete: boolean;
  foreign: boolean;
  unavailable: boolean;
};

const TIMED_OUT = Symbol('sandbox-reference-timeout');

async function withCallDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMED_OUT> {
  if (timeoutMs <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRetryDeadlineExceeded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}

function lookupSessionRuntimeLocator(
  env: Env,
  params: CanDestroyCloudAgentWorktreeSandboxParams,
  session: UnresolvedCloudAgentSandboxOwner['sessions'][number],
  deadlineAt: number
): Promise<SessionRuntimeLocator | null> {
  return withDORetry(
    () =>
      sessionPlaneFromId(session.cloudAgentSessionId) === 'control'
        ? getSandboxSessionStub(env, params.kiloUserId, session.cloudAgentSessionId)
        : resolveSessionStub(env, params.kiloUserId, session.cloudAgentSessionId),
    stub => stub.getRuntimeLocation(),
    'getRuntimeLocation',
    { ...DEFAULT_DO_RETRY_CONFIG, scope: { deadlineAt } }
  ).then(value => sessionRuntimeLocatorSchema.nullable().parse(value));
}

function matchesTarget(candidate: CloudAgentWorktreeLocation, target: CloudAgentWorktreeLocation) {
  return candidate.sandboxId === target.sandboxId && candidate.provider === target.provider;
}

function ownerNeedsRuntimeLookup(owner: UnresolvedCloudAgentSandboxOwner): boolean {
  if (owner.worktreeId !== null) return true;
  return owner.sessions.some(
    session => sessionPlaneFromId(session.cloudAgentSessionId) === 'control'
  );
}

type OwnerOutcome =
  | { kind: 'foreign' }
  | { kind: 'located' }
  | { kind: 'no-locator' }
  | { kind: 'exhausted' }
  | { kind: 'error'; error: unknown; mismatch: boolean };

export async function reconcileSandboxReferences(
  env: Env,
  params: CanDestroyCloudAgentWorktreeSandboxParams,
  limits: ReconciliationLimits = RECONCILIATION_LIMITS
): Promise<SandboxReferenceReconciliation> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + limits.budgetMs;
  const remaining = () => deadlineAt - Date.now();
  let decision = 'failed';
  let evidence = 'ledger';
  logControlDiagnostic('worktree_ownership', {
    worktreeId: params.worktreeId,
    sandboxId: params.location.sandboxId,
    provider: params.location.provider,
    phase: 'started',
  });
  try {
    const verdict = await withCallDeadline(
      () => env.SESSION_INGEST.canDestroyCloudAgentWorktreeSandbox(params),
      Math.min(limits.callTimeoutMs, remaining())
    );
    if (verdict === TIMED_OUT) {
      decision = 'unresolved';
      evidence = 'budget_exhausted';
      return { complete: false, foreign: false, unavailable: false };
    }
    const result = canDestroyCloudAgentWorktreeSandboxResultSchema.parse(verdict);
    if (result.kind === 'exclusive') {
      decision = 'exclusive';
      return { complete: true, foreign: false, unavailable: false };
    }
    if (result.kind === 'shared') {
      decision = 'shared';
      return { complete: false, foreign: true, unavailable: false };
    }
    const owners = result.owners;
    const outcomes: Array<OwnerOutcome | undefined> = Array.from({ length: owners.length });
    let foreign = false;
    let exhausted = false;
    let cursor = 0;

    const locateOwner = async (ownerIndex: number): Promise<OwnerOutcome> => {
      const owner = owners[ownerIndex];
      if (!ownerNeedsRuntimeLookup(owner)) {
        return owner.allocationLocation && matchesTarget(owner.allocationLocation, params.location)
          ? { kind: 'foreign' }
          : { kind: 'located' };
      }
      let located = false;
      for (const session of owner.sessions) {
        let locator: SessionRuntimeLocator | null;
        try {
          locator = await lookupSessionRuntimeLocator(
            env,
            params,
            session,
            Math.min(deadlineAt, Date.now() + limits.callTimeoutMs)
          );
        } catch (error) {
          if (isRetryDeadlineExceeded(error)) return { kind: 'exhausted' };
          return { kind: 'error', error, mismatch: false };
        }
        if (locator === null) continue;
        if (
          locator.cloudAgentSessionId !== session.cloudAgentSessionId ||
          locator.kiloUserId !== params.kiloUserId ||
          locator.organizationId !== owner.organizationId ||
          (session.sessionId !== null &&
            locator.sessionId !== null &&
            locator.sessionId !== session.sessionId) ||
          (owner.worktreeId !== null && locator.worktreeId !== owner.worktreeId)
        ) {
          return {
            kind: 'error',
            error: new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE),
            mismatch: true,
          };
        }
        located = true;
        if (matchesTarget(locator.location, params.location)) {
          return { kind: 'foreign' };
        }
      }
      if (!located) {
        if (!owner.allocationLocation) return { kind: 'no-locator' };
        if (matchesTarget(owner.allocationLocation, params.location)) {
          return { kind: 'foreign' };
        }
      }
      return { kind: 'located' };
    };

    const workers = Math.max(1, Math.min(limits.concurrency, owners.length));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (!foreign && !exhausted) {
          const ownerIndex = cursor++;
          if (ownerIndex >= owners.length) return;
          const outcome = await locateOwner(ownerIndex);
          outcomes[ownerIndex] = outcome;
          if (outcome.kind === 'exhausted') {
            exhausted = true;
            return;
          }
          if (outcome.kind === 'foreign') {
            foreign = true;
            return;
          }
        }
      })
    );

    let unavailable = false;
    for (let index = 0; index < owners.length; index++) {
      const outcome = outcomes[index];
      if (outcome === undefined || outcome.kind === 'exhausted') {
        decision = 'unresolved';
        evidence = 'budget_exhausted';
        return { complete: false, foreign: false, unavailable: false };
      }
      if (outcome.kind === 'foreign') {
        decision = 'shared';
        evidence = 'runtime_reconciliation';
        return { complete: false, foreign: true, unavailable: false };
      }
      if (outcome.kind === 'error') {
        decision = 'unresolved';
        evidence = outcome.mismatch ? 'locator_mismatch' : 'session_locator';
        throw outcome.error;
      }
      if (outcome.kind === 'no-locator') unavailable = true;
    }
    if (unavailable) {
      decision = 'unresolved';
      evidence = 'unavailable_history';
      return { complete: false, foreign: false, unavailable: true };
    }
    decision = 'exclusive';
    evidence = 'runtime_reconciliation';
    return { complete: true, foreign: false, unavailable: false };
  } finally {
    logControlDiagnostic(
      'worktree_ownership',
      {
        worktreeId: params.worktreeId,
        sandboxId: params.location.sandboxId,
        provider: params.location.provider,
        phase: 'finished',
        decision,
        evidence,
        durationMs: Date.now() - startedAt,
      },
      decision === 'failed' || decision === 'unresolved' ? 'warn' : 'info'
    );
  }
}
