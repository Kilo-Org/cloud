/**
 * The single e2e inspect route: the persisted allocation projection for one
 * session. It reuses the production access check and the production sandbox-id
 * derivation so the e2e surface cannot widen who may read a session, and it
 * returns only three fields: the logical sandbox id, the physical provider
 * reference and the persisted physical control-plane state.
 *
 * It deliberately never calls the freshness probes (`getExecutions`,
 * `isInterrupted`), never serializes raw session metadata, and distinguishes the
 * logical `sandboxId` from the physical `providerRef`.
 */

import type { Context } from 'hono';
import { generateSandboxId } from '../sandbox-id.js';
import { projectSessionAccessHttpError, requireCurrentSessionAccess } from '../session-access.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { resolveSessionStub } from '../sandbox-session/session-stub.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { CloudAgentSessionState } from '../persistence/types.js';
import type { HonoContext } from '../hono-context.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { legacyPhysicalState } from '../sandbox-state/project/physical-label.js';
import type { SandboxId, SessionId } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';

export type AllocationInspection = {
  logicalSandboxId: string;
  /** The physical provider reference, or `null` when no physical allocation exists. */
  physicalProviderRef: string | null;
  /**
   * Persisted control-plane physical state, or `null` when the control plane
   * owns no allocation for this session. This is stored state, not a fresh
   * liveness probe. It is reported while an allocation is being created even
   * before a provider reference exists (`state: 'creating'`).
   */
  physicalState: string | null;
};

export function projectAllocationInspection(
  logicalSandboxId: string,
  record: AllocationRecord
): AllocationInspection {
  const state = record.state;
  if (state.kind === 'stopped') {
    if (state.summary === null) {
      return { logicalSandboxId, physicalProviderRef: null, physicalState: null };
    }
    return {
      logicalSandboxId,
      physicalProviderRef: null,
      physicalState: 'stopped',
    };
  }

  const physicalProviderRef = state.target?.providerRef ?? null;
  const ownsAllocation = state.createIntent !== null || physicalProviderRef !== null;
  return {
    logicalSandboxId,
    physicalProviderRef,
    physicalState: ownsAllocation ? legacyPhysicalState(record) : null,
  };
}

export async function handleAllocationInspect(c: Context<HonoContext>): Promise<Response> {
  const userId = c.get('userId');
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const env = c.env;
  const sessionId = c.req.param('cloudAgentSessionId') as SessionId;

  try {
    await requireCurrentSessionAccess({
      env,
      kiloUserId: userId,
      cloudAgentSessionId: sessionId,
    });
  } catch (error) {
    return projectSessionAccessHttpError(error);
  }

  const getStub = () => resolveSessionStub(env, userId, sessionId);
  const metadata = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    CloudAgentSessionState | null
  >(getStub, stub => stub.getMetadata(), 'getMetadata');
  if (!metadata) {
    return new Response('Session not found', { status: 404 });
  }

  const logicalSandboxId: SandboxId =
    metadata.workspace?.sandboxId ??
    (await generateSandboxId(
      env.PER_SESSION_SANDBOX_ORG_IDS,
      metadata.identity.orgId,
      userId,
      metadata.identity.sessionId,
      metadata.identity.botId,
      { createdOnPlatform: metadata.identity.createdOnPlatform }
    ));

  const record = await getSandboxControlStub(env, logicalSandboxId).getAllocationRecord();
  return Response.json(projectAllocationInspection(logicalSandboxId, record));
}
