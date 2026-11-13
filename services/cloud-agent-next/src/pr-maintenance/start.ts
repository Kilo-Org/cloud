import { TRPCError } from '@trpc/server';
import { sha256Hex, normalizeGitUrl } from '@kilocode/worker-utils';
import { getPgDb } from '../db/pg.js';
import {
  loadWorkspaceSource,
  runSiblingCreate,
  sourceWorktreeBranchName,
} from '../router/handlers/session-worktree.js';
import { preflightAndQueuePromptMessage } from '../session/queue-message.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';
import type { Env, TRPCContext } from '../types.js';
import type { MaintenanceStart } from './contracts.js';
import type { MessageResultRPCResponse } from '../session/message-result.js';

export function maintenanceContext(env: Env, userId: string, authToken = ''): TRPCContext {
  return {
    env,
    userId,
    authToken,
    request: new Request('https://cloud-agent-next.internal/pr-maintenance'),
  };
}

export async function startMaintenanceChat(env: Env, input: MaintenanceStart) {
  const existing = await withDORetry(
    () => getSandboxSessionStub(env, input.userId, input.cloudAgentSessionId),
    stub => stub.getMaintenanceStatus(input.messageId),
    'getMaintenanceStatus'
  );
  if (existing?.stoppedAt !== null && existing?.stoppedAt !== undefined) {
    throw new TRPCError({ code: 'CONFLICT', message: 'maintenance_attempt_stopped' });
  }
  const ctx = maintenanceContext(env, input.userId, input.runtimeToken);
  const db = getPgDb(env);
  const source = await loadWorkspaceSource(db, ctx, input.worktreeId, input.organizationId, {
    allowInteractiveOrigin: true,
  });
  if (
    normalizeGitUrl(
      source.repository.type === 'github'
        ? `https://github.com/${source.repository.repo}`
        : source.repository.url
    ) !== normalizeGitUrl(input.publication.repoUrl) ||
    sourceWorktreeBranchName(source) !== input.publication.headRef ||
    (source.ownership.profileId ?? null) !== input.profileId ||
    (source.metadata.environment?.environmentId ?? null) !== input.environmentId
  )
    throw new TRPCError({ code: 'CONFLICT', message: 'maintenance_workspace_identity_changed' });

  const { runtimeToken, runtimeAuthorizationSeal, ...intent } = input;
  const fingerprint = await sha256Hex(JSON.stringify(intent));
  const agent = {
    mode: 'code',
    model: input.model,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
  };
  return runSiblingCreate({
    db,
    ctx,
    source,
    intent: 'create_workspace_session',
    operationKey: input.creationOperationKey,
    organizationId: input.organizationId,
    options: {
      fingerprint,
      requestedKiloSessionId: input.kiloSessionId,
      requestedCloudAgentSessionId: input.cloudAgentSessionId,
      agent,
      title: 'Pull request auto-fix',
      chat: {
        kind: 'maintenance',
        watchId: input.watchId,
        attemptId: input.attemptId,
        publication: input.publication,
        allowRebase: input.allowRebase ?? false,
        parentCommitSha: input.parentCommitSha ?? null,
        recoverableAttemptIds: input.recoverableAttemptIds ?? [],
      },
      initialTurn: {
        messageId: input.messageId,
        requestedMessageId: input.messageId,
        deliver: async progress => {
          const state = await withDORetry(
            () => getSandboxSessionStub(env, input.userId, progress.cloudAgentSessionId),
            (stub): Promise<MessageResultRPCResponse> => stub.getMessageResult(input.messageId),
            'getMessageResult'
          );
          if (state.type === 'found') return;
          if (state.type === 'state-invalid')
            throw new TRPCError({ code: 'CONFLICT', message: 'maintenance_message_state_invalid' });
          await preflightAndQueuePromptMessage(
            {
              cloudAgentSessionId: progress.cloudAgentSessionId,
              turn: { type: 'prompt', id: input.messageId, prompt: input.prompt },
              agent,
              finalization: { autoCommit: false },
            },
            { env, userId: input.userId, authToken: runtimeToken },
            'pr_maintenance'
          );
        },
      },
    },
    preissuedRuntimeAuthorization: { token: runtimeToken, seal: runtimeAuthorizationSeal },
    mapProgress: (progress, replayed) => ({
      worktreeId: progress.worktreeId,
      cloudAgentSessionId: progress.cloudAgentSessionId,
      kiloSessionId: progress.kiloSessionId,
      messageId: input.messageId,
      ...(replayed ? { replayed: true } : {}),
    }),
  });
}
