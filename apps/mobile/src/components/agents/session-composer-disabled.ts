/**
 * Structural locks on the session composer. These stop the reader from writing
 * a message at all: a read-only session, a skeleton/slow-load body, a blocking
 * card that owns the composer slot, or a Cloud Agent session with no model
 * picked yet.
 *
 * The live send capability is deliberately NOT part of this lock. A failed
 * turn, a dropped remote owner or an unresolved open leaves the session unable
 * to accept a message for a while; locking the input for that window is what
 * made the composer offer only Retry after an agent error (Pylon 28248). Send
 * capability keeps gating the send control — see `sendDisabled` on
 * `ChatComposer` — so the reader can type the next message beside the Retry
 * while the session is unavailable.
 */
export function resolveSessionComposerDisabled(input: {
  isReadOnly: boolean;
  shouldShowLoading: boolean;
  hasBlockingInteraction: boolean;
  requiresModel: boolean;
  hasModel: boolean;
}): boolean {
  return (
    input.isReadOnly ||
    input.shouldShowLoading ||
    input.hasBlockingInteraction ||
    (input.requiresModel && !input.hasModel)
  );
}
