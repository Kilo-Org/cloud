import { TRPCError } from '@trpc/server';
import { parseWorkspaceSessionCallbackTarget } from '@kilocode/worker-utils/cloud-agent-authority';
import {
  CHILD_SESSION_CALLBACK_VERSION,
  formatChildSessionCallbackPrompt,
  type ChildSessionCallbackPayload,
} from '@kilocode/worker-utils/cloud-agent-child-callback';
import { requireCurrentSessionAccess } from '../session-access.js';
import { fetchSessionMetadata } from '../session/metadata.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { isWorkspaceAnchorMetadata } from '../cloud-agent-authority.js';
import { isCanonicalMessageId } from '../session/message-id.js';
import { preflightAndQueuePromptMessage } from '../session/queue-message.js';
import type { Env } from '../types.js';
import { classifyCallbackError, type DeliveryResult } from './delivery.js';
import type { CallbackJob, ExecutionCallbackPayload } from './types.js';

const RESULT_MAX_LENGTH = 12_000;

export function callbackResultInfo(payload: ExecutionCallbackPayload): ChildSessionCallbackPayload {
  const result = payload.lastAssistantMessageText || payload.recentActivity;
  return {
    version: CHILD_SESSION_CALLBACK_VERSION,
    cloudAgentSessionId: payload.cloudAgentSessionId,
    kiloSessionId: payload.kiloSessionId,
    messageId: payload.messageId,
    status: payload.status,
    gateResult: payload.gateResult,
    failure: payload.failure,
    failureStage: payload.failureStage,
    errorMessage: payload.errorMessage?.slice(0, RESULT_MAX_LENGTH),
    branch: payload.lastSeenBranch,
    result: result?.slice(0, RESULT_MAX_LENGTH),
    resultTruncated:
      (result !== undefined && result.length > RESULT_MAX_LENGTH) ||
      payload.lastAssistantMessageTextTruncation !== undefined ||
      undefined,
  };
}

export function parentSessionCallbackPrompt(
  payload: ExecutionCallbackPayload,
  destinationSessionId?: string
): string {
  return formatChildSessionCallbackPrompt({
    ...callbackResultInfo(payload),
    ...(destinationSessionId ? { callbackSessionId: destinationSessionId } : {}),
  });
}

/** Resolves the child's stored lineage and revalidates the canonical parent. */
export async function resolveParentCallbackSession(
  env: Env,
  userId: string,
  childSessionId: string
): Promise<{ parentSessionId: string; parent: SessionMetadata }> {
  const child = await fetchSessionMetadata(env, userId, childSessionId);
  const parentSessionId = child?.parentCloudAgentSessionId;
  if (
    !child ||
    child.identity.userId !== userId ||
    child.identity.sessionId !== childSessionId ||
    !parentSessionId?.startsWith('workspace_') ||
    parentSessionId === child.identity.sessionId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Child session lineage unavailable' });
  }
  const parent = await fetchSessionMetadata(env, userId, parentSessionId);
  if (
    !parent ||
    parent.identity.sessionId !== parentSessionId ||
    parent.identity.userId !== userId ||
    (parent.identity.orgId ?? null) !== (child.identity.orgId ?? null) ||
    parent.allowSubagentSessions !== true
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Parent session callback denied' });
  }
  await requireCurrentSessionAccess({
    env,
    kiloUserId: userId,
    cloudAgentSessionId: parentSessionId,
    expectedOrganizationId: parent.identity.orgId ?? null,
    expectedKiloSessionId: parent.auth.kiloSessionId,
  });
  return { parentSessionId, parent };
}

/**
 * Delivers a child result to one existing chat in the child's parent workspace.
 * This path rechecks lineage, workspace, owner, organization and current
 * access before queuing the result.
 */
export async function deliverWorkspaceSessionCallback(
  env: Env,
  job: CallbackJob,
  attempts: number
): Promise<DeliveryResult> {
  const source = job.parentSession;
  const targetSessionId = parseWorkspaceSessionCallbackTarget(job.target.url);
  if (
    targetSessionId === null ||
    !source?.userId ||
    !isCanonicalMessageId(source.messageId) ||
    !job.payload.cloudAgentSessionId.startsWith('workspace_') ||
    job.payload.sessionId !== job.payload.cloudAgentSessionId
  ) {
    return { type: 'failed', error: 'Invalid workspace session callback' };
  }

  try {
    const { parent } = await resolveParentCallbackSession(
      env,
      source.userId,
      job.payload.cloudAgentSessionId
    );
    const target = await fetchSessionMetadata(env, source.userId, targetSessionId);
    if (
      !target ||
      !isWorkspaceAnchorMetadata(parent) ||
      target.identity.sessionId !== targetSessionId ||
      target.identity.userId !== source.userId ||
      (target.identity.orgId ?? null) !== (parent.identity.orgId ?? null) ||
      target.parentCloudAgentSessionId !== undefined ||
      target.workspace?.worktreeId === undefined ||
      target.workspace.worktreeId !== parent.workspace?.worktreeId
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace session callback denied' });
    }
    await requireCurrentSessionAccess({
      env,
      kiloUserId: source.userId,
      cloudAgentSessionId: targetSessionId,
      expectedOrganizationId: target.identity.orgId ?? null,
      expectedKiloSessionId: target.auth.kiloSessionId,
    });
    await preflightAndQueuePromptMessage(
      {
        cloudAgentSessionId: targetSessionId,
        turn: {
          type: 'prompt',
          id: source.messageId,
          prompt: parentSessionCallbackPrompt(job.payload, targetSessionId),
        },
      },
      { env, userId: source.userId },
      'workspace_session_callback'
    );
    return { type: 'success' };
  } catch (error) {
    return classifyCallbackError(
      error,
      job.payload,
      attempts,
      'Workspace session callback unavailable'
    );
  }
}
