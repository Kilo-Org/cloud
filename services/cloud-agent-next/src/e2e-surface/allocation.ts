/**
 * The single e2e inspect route: the persisted allocation projection for one
 * session. It reuses the production access check and the production sandbox-id
 * derivation so the e2e surface cannot widen who may read a session, and it
 * returns only the observable allocation fields: the logical sandbox id, the
 * physical provider reference, the persisted provider and the persisted
 * physical control-plane state.
 *
 * It deliberately never calls freshness probes, never serializes raw session
 * metadata, and distinguishes the logical `sandboxId` from the physical
 * `providerRef`. It reads the control-plane Sandbox DO's stored allocation
 * state, not a liveness probe.
 */

import type { Context } from 'hono';
import { generateSandboxId } from '../sandbox-id.js';
import { projectSessionAccessHttpError, requireCurrentSessionAccess } from '../session-access.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { resolveSessionStub, type SessionStub } from '../sandbox-session/session-stub.js';
import type { CloudAgentSessionState } from '../persistence/types.js';
import type { HonoContext } from '../hono-context.js';
import type { AllocationView } from '../control-plane/sandbox/allocation.js';
import type { AgentSandboxProvider, SandboxId, SessionId } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';

export type AllocationInspection = {
  logicalSandboxId: string;
  /** The physical provider reference, or `null` when no physical allocation exists. */
  physicalProviderRef: string | null;
  /**
   * The provider kind the persisted pin owns for this allocation, read straight
   * from `getAllocationState()`. It lets an explicit-allocation run fail closed
   * when the observed provider does not match the requested allocation instead
   * of treating any present reference as a successful boot.
   */
  provider: AgentSandboxProvider;
  /**
   * Persisted control-plane physical state, or `null` when the control plane
   * owns no allocation for this session. This is stored state, not a fresh
   * liveness probe. It is reported while an allocation is being created even
   * before a provider reference exists (`state: 'creating'`).
   */
  physicalState: string | null;
};

/** Projects the persisted allocation state into the flat inspection response. */
export function projectAllocationInspection(
  logicalSandboxId: string,
  state: AllocationView
): AllocationInspection {
  const physicalProviderRef = state.providerRef ?? state.unconfirmedProviderRef ?? null;
  if (state.kind === 'stopped') {
    const ownsAllocation = state.allocationId !== null || physicalProviderRef !== null;
    return {
      logicalSandboxId,
      physicalProviderRef: ownsAllocation ? physicalProviderRef : null,
      provider: state.provider,
      physicalState: !ownsAllocation ? null : physicalProviderRef !== null ? 'unknown' : 'stopped',
    };
  }
  const physicalState =
    state.kind === 'starting' ? 'creating' : state.kind === 'stopping' ? 'stopping' : 'running';
  return { logicalSandboxId, physicalProviderRef, provider: state.provider, physicalState };
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
  const metadata = await withDORetry<SessionStub, CloudAgentSessionState | null>(
    getStub,
    stub => stub.getMetadata(),
    'getMetadata'
  );
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
      { createdOnPlatform: metadata.identity.createdOnPlatform, legacyFallback: true }
    ));

  const state = await withDORetry(
    () => getSandboxControlStub(env, logicalSandboxId),
    stub => stub.getAllocationState(),
    'getAllocationState'
  );
  return Response.json(projectAllocationInspection(logicalSandboxId, state));
}
