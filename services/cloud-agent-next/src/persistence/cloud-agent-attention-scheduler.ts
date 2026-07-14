/**
 * Synchronous scheduling helper for Cloud Agent attention events.
 *
 * This module owns the thin adapter that forwards classified wrapper
 * attention events (question/permission raises and resolves) to the
 * SESSION_INGEST service. It is kept separate from CloudAgentSession so
 * the private-field-heavy DO can be excluded from unit tests: the contract
 * only needs a session identity, a metadata accessor, and the service binding.
 */
import type {
  RecordCloudAgentSessionAttentionParams,
  RecordCloudAgentSessionAttentionResult,
} from '@kilocode/session-ingest-contracts';
import { logger } from '../logger.js';
import type { AttentionEvent } from '../websocket/ingest-attention-classifier.js';
import type { SessionId } from '../types/ids.js';
import type { SessionMetadata } from './session-metadata.js';

export type CloudAgentAttentionDeps = {
  sessionId: SessionId | undefined;
  getMetadata: () => Promise<SessionMetadata | null | undefined>;
  env: {
    SESSION_INGEST: {
      recordCloudAgentSessionAttention: (
        params: RecordCloudAgentSessionAttentionParams
      ) => Promise<RecordCloudAgentSessionAttentionResult>;
    };
  };
};

/**
 * Synchronously hand an attention event off to `ctx.waitUntil`. The async body
 * fetches session metadata, validates identity, maps the classified intent to
 * the ingest contract shape, and calls `recordCloudAgentSessionAttention`.
 *
 * Failures are non-fatal and privacy-safe: no `requestId`, reason, payload,
 * or error message is ever logged — only the session identity, which the worker
 * already knows. Duplicates are forwarded each time; the outbox downstream owns
 * deduplication.
 */
export function scheduleCloudAgentAttention(
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  deps: CloudAgentAttentionDeps,
  event: AttentionEvent
): void {
  ctx.waitUntil(runCloudAgentAttentionEvent(deps, event));
}

async function runCloudAgentAttentionEvent(
  deps: CloudAgentAttentionDeps,
  event: AttentionEvent
): Promise<void> {
  try {
    const metadata = await deps.getMetadata();
    if (!metadata) {
      logger
        .withFields({ sessionId: deps.sessionId })
        .warn('Cloud Agent attention event dropped: metadata missing');
      return;
    }
    const kiloUserId = metadata.identity.userId;
    const kiloSessionId = metadata.auth.kiloSessionId;
    if (!kiloUserId || !kiloSessionId) {
      logger
        .withFields({ sessionId: deps.sessionId })
        .warn('Cloud Agent attention event dropped: session identity missing');
      return;
    }
    if (event.sourceKiloSessionId !== kiloSessionId) {
      logger
        .withFields({ sessionId: deps.sessionId })
        .warn('Cloud Agent attention event dropped: source session mismatch');
      return;
    }
    const intent =
      'raise' in event.intent
        ? { kind: 'raise' as const, reason: event.intent.raise }
        : { kind: 'resolve' as const, reason: event.intent.resolve };
    const result = await deps.env.SESSION_INGEST.recordCloudAgentSessionAttention({
      kiloUserId,
      kiloSessionId,
      requestId: event.requestId,
      intent,
    });
    if (!result.accepted) {
      logger
        .withFields({ sessionId: deps.sessionId })
        .warn('Cloud Agent attention event not accepted');
    }
  } catch {
    // Privacy-safe: do not log requestId, reason, or error message.
    logger.withFields({ sessionId: deps.sessionId }).warn('Cloud Agent attention event failed');
  }
}
