import { TRPCError } from '@trpc/server';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { PARENT_WORKSPACE_CALLBACK_URL } from '@kilocode/worker-utils/cloud-agent-authority';
import {
  formatChildQuestionCallbackPrompt,
  formatChildSessionCallbackPrompt,
} from '@kilocode/worker-utils/cloud-agent-child-callback';
import { sha256Hex } from '@kilocode/worker-utils';
import { isCanonicalMessageId } from '../session/message-id.js';
import { getWorkspaceStub } from '../control-plane/workspace/workspace-stub.js';
import { createWorkspaceCallbackSession } from '../router/handlers/session-worktree.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import { classifyCallbackError, type DeliveryResult } from './delivery.js';
import { callbackResultInfo, resolveCallbackWorkspace } from './parent-session.js';
import type { CallbackQueueJob, ExecutionCallbackPayload } from './types.js';

/** Deterministic creation conflicts cannot recover through redelivery. */
const PERMANENT_CONFLICT_MESSAGES = new Set([
  'Callback workspace session mismatch',
  'operation_key_reuse_mismatch',
  'session_create_intent_conflict',
]);

function isPermanentWorkspaceCallbackError(error: unknown): boolean {
  return error instanceof TRPCError && PERMANENT_CONFLICT_MESSAGES.has(error.message);
}

function uuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20
  )}-${hex.slice(20, 32)}`;
}

export async function callbackWorkspaceSessionIds(
  userId: string,
  payload: Pick<ExecutionCallbackPayload, 'sessionId' | 'messageId'>,
  messageId: string
): Promise<{ operationKey: string; siblingSessionId: string }> {
  const base = `${userId}:${payload.sessionId}:${payload.messageId}:${messageId}`;
  const [operationHex, sessionHex] = await Promise.all([
    sha256Hex(`callback-workspace-operation:${base}`),
    sha256Hex(`callback-workspace-session:${base}`),
  ]);
  return {
    operationKey: uuidFromHex(operationHex),
    siblingSessionId: `workspace_${uuidFromHex(sessionHex)}`,
  };
}

export function parentWorkspaceCallbackPrompt(
  payload: ExecutionCallbackPayload,
  destinationSessionId: string
): string {
  return formatChildSessionCallbackPrompt({
    ...callbackResultInfo(payload),
    callbackSessionId: destinationSessionId,
  });
}

/** Creates a new chat in the parent workspace using the child result as its first message. */
export async function deliverParentWorkspaceCallback(
  env: Env,
  job: CallbackQueueJob,
  attempts: number
): Promise<DeliveryResult> {
  const source = job.parentSession;
  const interaction = 'type' in job;
  if (
    job.target.url !== PARENT_WORKSPACE_CALLBACK_URL ||
    !source?.userId ||
    !isCanonicalMessageId(source.messageId) ||
    !job.payload.cloudAgentSessionId.startsWith('workspace_') ||
    (!interaction && job.payload.sessionId !== job.payload.cloudAgentSessionId)
  ) {
    return { type: 'failed', error: 'Invalid parent workspace callback' };
  }

  try {
    const workspace = await resolveCallbackWorkspace(
      env,
      source.userId,
      job.payload.cloudAgentSessionId
    );
    const workspaceId = cloudAgentWorktreeIdSchema.safeParse(workspace.worktreeId).data;
    if (workspaceId === undefined) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Parent workspace callback denied' });
    }

    const { operationKey, siblingSessionId } = await callbackWorkspaceSessionIds(
      source.userId,
      interaction
        ? { sessionId: job.payload.cloudAgentSessionId, messageId: job.payload.question.id }
        : job.payload,
      source.messageId
    );
    const delegated = await withDORetry(
      () => getWorkspaceStub(env, source.userId, workspace.workspaceSessionId),
      stub => stub.authorizeChat({ chatSessionId: siblingSessionId }),
      'authorizeChat'
    );
    if (delegated.worktreeId !== workspaceId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Parent workspace callback denied' });
    }
    const runtimeAuthorization = {
      token: delegated.token,
      tokens: delegated.tokens,
      seal: delegated.seal,
    };
    const created = await createWorkspaceCallbackSession({
      env,
      userId: source.userId,
      authToken: runtimeAuthorization.token,
      organizationId: delegated.organizationId ?? undefined,
      workspaceId,
      operationKey,
      siblingSessionId,
      messageId: source.messageId,
      prompt: interaction
        ? formatChildQuestionCallbackPrompt(job.payload)
        : parentWorkspaceCallbackPrompt(job.payload, siblingSessionId),
      title: `${interaction ? 'Child question' : 'Child result'} ${job.payload.cloudAgentSessionId.slice(-8)}`,
      runtimeAuthorization,
    });
    if (created.cloudAgentSessionId !== siblingSessionId) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Callback workspace session mismatch' });
    }
    return { type: 'success' };
  } catch (error) {
    return classifyCallbackError(
      error,
      job.payload,
      attempts,
      'Parent workspace callback unavailable',
      isPermanentWorkspaceCallbackError(error)
    );
  }
}
