import { z } from 'zod';
import {
  canDestroyCloudAgentWorktreeSandboxResultSchema,
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeLocationSchema,
  sessionIdSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
  type CanDestroyCloudAgentWorktreeSandboxParams,
} from '@kilocode/session-ingest-contracts';
import { getSandboxProvider, type SessionMetadata } from '../persistence/session-metadata';
import { getSandboxSessionStub, resolveSessionStub } from '../sandbox-session/session-stub';
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

export async function resolveSandboxExclusivity(
  env: Env,
  params: CanDestroyCloudAgentWorktreeSandboxParams
): Promise<boolean> {
  const startedAt = Date.now();
  let decision = 'failed';
  let evidence = 'ledger';
  logControlDiagnostic('worktree_ownership', {
    worktreeId: params.worktreeId,
    sandboxId: params.location.sandboxId,
    provider: params.location.provider,
    phase: 'started',
  });
  try {
    const result = canDestroyCloudAgentWorktreeSandboxResultSchema.parse(
      await env.SESSION_INGEST.canDestroyCloudAgentWorktreeSandbox(params)
    );
    if (result.kind === 'exclusive') {
      decision = 'exclusive';
      return true;
    }
    if (result.kind === 'shared') {
      decision = 'shared';
      return false;
    }
    let unavailable = false;
    for (const owner of result.owners) {
      let located = false;
      for (const session of owner.sessions) {
        evidence = 'session_locator';
        const locator = sessionRuntimeLocatorSchema.nullable().parse(
          await withDORetry(
            () =>
              session.cloudAgentSessionId.startsWith('workspace_')
                ? getSandboxSessionStub(env, params.kiloUserId, session.cloudAgentSessionId)
                : resolveSessionStub(env, params.kiloUserId, session.cloudAgentSessionId),
            stub => stub.getRuntimeLocation(),
            'getRuntimeLocation'
          )
        );
        if (!locator) continue;
        if (
          locator.cloudAgentSessionId !== session.cloudAgentSessionId ||
          locator.kiloUserId !== params.kiloUserId ||
          locator.organizationId !== owner.organizationId ||
          (session.sessionId !== null &&
            locator.sessionId !== null &&
            locator.sessionId !== session.sessionId) ||
          (owner.worktreeId !== null && locator.worktreeId !== owner.worktreeId)
        ) {
          decision = 'unresolved';
          evidence = 'locator_mismatch';
          throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
        }
        located = true;
        if (
          locator.location.sandboxId === params.location.sandboxId &&
          locator.location.provider === params.location.provider
        ) {
          decision = 'shared';
          return false;
        }
      }
      if (!located && owner.allocationLocation) {
        evidence = 'allocation_fallback';
        located = true;
        if (
          owner.allocationLocation.sandboxId === params.location.sandboxId &&
          owner.allocationLocation.provider === params.location.provider
        ) {
          decision = 'shared';
          return false;
        }
      }
      if (!located) unavailable = true;
    }
    decision = unavailable ? 'unresolved' : 'exclusive';
    evidence = unavailable ? 'unavailable_history' : 'runtime_reconciliation';
    return !unavailable;
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
