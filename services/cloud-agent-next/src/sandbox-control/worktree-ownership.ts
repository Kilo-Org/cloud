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
  const result = canDestroyCloudAgentWorktreeSandboxResultSchema.parse(
    await env.SESSION_INGEST.canDestroyCloudAgentWorktreeSandbox(params)
  );
  if (result.kind === 'exclusive') return true;
  if (result.kind === 'shared') return false;
  let unavailable = false;
  for (const owner of result.owners) {
    let located = false;
    for (const session of owner.sessions) {
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
        throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
      }
      located = true;
      if (
        locator.location.sandboxId === params.location.sandboxId &&
        locator.location.provider === params.location.provider
      )
        return false;
    }
    if (!located && owner.allocationLocation) {
      located = true;
      if (
        owner.allocationLocation.sandboxId === params.location.sandboxId &&
        owner.allocationLocation.provider === params.location.provider
      )
        return false;
    }
    if (!located) unavailable = true;
  }
  return !unavailable;
}
