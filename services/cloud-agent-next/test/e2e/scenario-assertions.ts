/**
 * Shared scenario assertions with no local-only dependencies: pure functions
 * over a `StreamConnection`'s event buffer and over collected assistant text, so
 * both the shared public-surface scenarios and the capability-backed faults can
 * use them without importing a Docker, log or database module.
 */

import { messageIdFromEvent, type StreamConnection } from './client.js';

/**
 * One shared lifecycle assertion for a matching message: the stream must show
 * the ordered `cloud.message.queued` -> `cloud.message.sent` ->
 * `cloud.message.completed` sequence (with no `cloud.message.failed`), and the
 * durable message must be `completed`. Callers additionally require the durable
 * status; this returns the observed stream phases for evidence.
 *
 * `queued` is required, not optional. Every admitted user message emits it
 * before acceptance can emit `sent`: admission runs
 * `completeQueuedAdmissionEffects` -> `repairQueuedAdmissionEffects` ->
 * `ensureQueuedMessageEvent` (`src/session/session-message-queue.ts:714`,
 * `:690`), which inserts and broadcasts `cloud.message.queued`
 * (`src/persistence/CloudAgentSession.ts:1548`). `cloud.message.sent` is only
 * written on acceptance (`src/persistence/CloudAgentSession.ts:3204`), which
 * always happens after admission, including the directly-accepted
 * `admitAcceptedMessage` path. There is no path that emits `sent` without first
 * emitting `queued`, so the assertion requires the full ordered prefix.
 */
export function assertMessageLifecycle(
  stream: StreamConnection,
  messageId: string,
  label: string
): string {
  const types = stream.events
    .filter(event => messageIdFromEvent(event) === messageId)
    .map(event => event.streamEventType)
    .filter(type => type.startsWith('cloud.message.'));
  if (types.includes('cloud.message.failed')) {
    throw new Error(`${label} has a failed lifecycle for ${messageId}: ${types.join('>')}`);
  }
  const queuedIndex = types.indexOf('cloud.message.queued');
  const sentIndex = types.indexOf('cloud.message.sent');
  const completedIndex = types.findIndex(
    (type, index) => type === 'cloud.message.completed' && index > sentIndex
  );
  if (sentIndex === -1) {
    throw new Error(
      `${label} has no cloud.message.sent for ${messageId}: ${types.join('>') || 'none'}`
    );
  }
  if (completedIndex === -1) {
    throw new Error(
      `${label} has no cloud.message.completed after sent for ${messageId}: ${types.join('>')}`
    );
  }
  if (queuedIndex === -1) {
    throw new Error(
      `${label} has no cloud.message.queued for ${messageId}: ${types.join('>') || 'none'}`
    );
  }
  if (queuedIndex > sentIndex) {
    throw new Error(`${label} queued did not precede sent for ${messageId}: ${types.join('>')}`);
  }
  return types.join('>');
}

/**
 * Find the exact `file-read:<path>` header line and return everything after it,
 * verbatim (no trimming). The fake emits the header and the parsed read body as
 * one assistant message; callers compare the returned body with the nonce or
 * fixture they seeded, so the bytes must survive untouched. Returns `null` when
 * the exact header line is absent, so a different path's echo can never be
 * mistaken for this one.
 */
export function parseFileReadEcho(text: string, path: string): string | null {
  const header = `file-read:${path}`;
  const lines = text.split('\n');
  const index = lines.findIndex(line => line === header);
  if (index < 0) return null;
  return lines.slice(index + 1).join('\n');
}

/**
 * Require a read echo body to be the writer's private nonce and reject a body
 * equal to anything the reader could derive from the request it issued (the
 * path and tag). Without this, a body synthesized from reader-visible inputs
 * would satisfy a loose check and the "reader cannot know the content"
 * argument would be unproven.
 */
export function assertReaderCannotDeriveNonce(input: {
  body: string | null;
  expectedNonce: string;
  readerVisible: string;
  label: string;
}): void {
  if (input.body === input.readerVisible) {
    throw new Error(
      `${input.label} echo body matched a reader-derived value (${JSON.stringify(input.readerVisible)}), not the writer's private nonce`
    );
  }
  if (input.body !== input.expectedNonce) {
    throw new Error(
      `${input.label} echo body=${JSON.stringify(input.body)}; expected the writer's private nonce`
    );
  }
}
