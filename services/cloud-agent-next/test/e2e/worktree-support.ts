import {
  fetchFakeScenarioStatus,
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

/**
 * Public-surface-only helpers re-exported for the import sites this module's
 * callers already use. These two are not used by the Docker-dependent helpers
 * below.
 */
export { readWorktreeOwnership, requireWorktreeSessionIdentity } from './public-surface-support.js';
export type { WorktreeOwnershipRow } from './public-surface-support.js';

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
