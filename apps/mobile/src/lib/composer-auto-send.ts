/**
 * Whether the destination composer must submit its share-prefilled content
 * without a further tap. The caller latches `alreadyFired` after it submits,
 * so this fires at most once per mount.
 *
 * `shareDelivered` is the ordering gate: text lands before files, so a rule
 * built on `hasText` alone would send the text and drop the files.
 *
 * `attachmentsEnabled` keeps the one-shot latch unspent while a freshly
 * spawned remote session has not yet advertised `capabilities.attachments`.
 * Sending early would hit the composer's "can't receive files" refusal and
 * burn the latch for a session that becomes capable a moment later.
 */
export function shouldAutoSendPrefilledShare(input: {
  autoSend: boolean;
  alreadyFired: boolean;
  shareDelivered: boolean;
  hasText: boolean;
  hasAttachments: boolean;
  attachmentsEnabled: boolean;
  canSend: boolean;
  isUploading: boolean;
  hasFailedAttachments: boolean;
}): boolean {
  if (!input.autoSend || input.alreadyFired || !input.shareDelivered) {
    return false;
  }
  if (!input.hasText || !input.canSend) {
    return false;
  }
  if (input.isUploading || input.hasFailedAttachments) {
    return false;
  }
  if (input.hasAttachments && !input.attachmentsEnabled) {
    return false;
  }
  return true;
}
