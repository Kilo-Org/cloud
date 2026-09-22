import {
  fetchFakeScenarioStatus,
  getSessionSnapshot,
  messageIdFromEvent,
  waitForGateEngaged,
  type DriverConfig,
  type StreamConnection,
  type WorktreeSessionResult,
} from './client.js';
import {
  waitForControlPlaneKiloCompletion,
  type ControlPlaneKiloRuntime,
} from './sandbox-control.js';

export type WorktreeOwnershipRow = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  parentSessionId: string | null;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
  worktreeId: string | null;
};

export async function readWorktreeOwnership(
  config: DriverConfig,
  cloudAgentSessionIds: string[]
): Promise<WorktreeOwnershipRow[]> {
  const rows: WorktreeOwnershipRow[] = [];
  for (const cloudAgentSessionId of cloudAgentSessionIds) {
    const snapshot = await getSessionSnapshot(config, cloudAgentSessionId);
    if (!snapshot.kiloSessionId) {
      throw new Error(`getSession(${cloudAgentSessionId}) returned no kiloSessionId`);
    }
    rows.push({
      sessionId: snapshot.kiloSessionId,
      userId: snapshot.userId,
      organizationId: snapshot.orgId ?? null,
      parentSessionId: snapshot.parentSessionId ?? null,
      cloudAgentSessionId: snapshot.sessionId,
      cloudAgentSessionScopeId: snapshot.cloudAgentSessionScopeId ?? null,
      worktreeId: snapshot.worktreeId ?? null,
    });
  }
  return rows;
}

export function requireWorktreeSessionIdentity(
  session: WorktreeSessionResult,
  label: string
): void {
  if (!/^workspace_[0-9a-f-]{36}$/i.test(session.cloudAgentSessionId)) {
    throw new Error(`${label} did not receive a control-plane workspace_* identity`);
  }
  if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session.kiloSessionId)) {
    throw new Error(`${label} did not receive a valid root ses_* identity`);
  }
}

export async function requireWorktreeGate(
  config: DriverConfig,
  tag: string,
  timeoutMs: number,
  stream?: StreamConnection,
  messageId?: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const firstEvent = stream?.events.length ?? 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal);
    const [engaged, status] = await Promise.all([
      waitForGateEngaged(config, tag, 200, 50, signal),
      fetchFakeScenarioStatus(config.fakeLlmUrl, tag, signal),
    ]);
    if (status.unsupportedToolSchema) {
      throw new Error(`unsupported real Kilo tool schema for fake directive ${tag}`);
    }
    if (engaged) return;
    // With a message id, fail fast on a failure this exact message already
    // received before the wait began. Without one, keep the window scoped to
    // this gate so a multi-turn caller never reads an earlier turn's failure
    // as this gate miss.
    const observed = messageId === undefined ? stream?.events.slice(firstEvent) : stream?.events;
    const failure = observed?.find(
      event =>
        ['error', 'interrupted', 'cloud.message.failed'].includes(event.streamEventType) &&
        (messageId === undefined || messageIdFromEvent(event) === messageId)
    );
    if (failure) {
      throw new Error(
        `fake directive ${tag} terminated as ${failure.streamEventType} before gating`
      );
    }
  }
  if (signal?.aborted) throw abortError(signal);
  const status = await fetchFakeScenarioStatus(config.fakeLlmUrl, tag, signal);
  if (status.requests > 0 && Object.values(status.toolCalls).every(count => count === 0)) {
    throw new Error(`required real Kilo tool schema was not advertised for fake directive ${tag}`);
  }
  throw new Error(
    `fake directive ${tag} did not engage within ${timeoutMs}ms; requests=${status.requests}; toolCalls=${JSON.stringify(status.toolCalls)}; toolResults=${JSON.stringify(status.toolResults)}`
  );
}

/** Preserve the deadline's own reason so an aborted gate read is not misread as a gate miss. */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('gate wait aborted');
}

export async function waitForOwnedCompletion(
  runtime: ControlPlaneKiloRuntime,
  session: WorktreeSessionResult,
  messageId: string,
  marker: string,
  timeoutMs = 15_000
): Promise<void> {
  await waitForControlPlaneKiloCompletion(runtime, {
    kiloSessionId: session.kiloSessionId,
    messageId,
    expectedText: marker,
    timeoutMs,
  });
}
