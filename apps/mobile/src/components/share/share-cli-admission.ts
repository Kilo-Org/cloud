import { type SharePayloadValidation } from './share-payload-validation';

export type ShareDestinationAdmission =
  | { ok: true }
  | { ok: false; title: string; message: string };

/**
 * Whether the share still carries files the destination must accept.
 * Uses the validated accepted set once classification finishes so rejected
 * files do not block a text-only commit to an attachments-incapable CLI.
 */
export function resolveShareHasFiles(
  validation: SharePayloadValidation | null,
  rawFileCount: number
): boolean {
  if (validation === null) {
    return rawFileCount > 0;
  }
  if (validation.kind === 'ok') {
    return validation.accepted.length > 0;
  }
  // all-rejected: gate is terminal no-list; harmless default.
  return false;
}

/**
 * Decide whether a share payload may be committed to a destination row.
 * Non-CLI platforms pass through; CLI rows require a live session, and
 * file payloads additionally require `capabilities.attachments`.
 */
export function resolveShareDestinationAdmission(input: {
  /** `created_on_platform` of the stored row. */
  createdOnPlatform: string | null;
  /** True when the row's session id is in the active-sessions set. */
  live: boolean;
  /** `capabilities.attachments === true` for the live row; false otherwise. */
  attachmentsCapable: boolean;
  /** True when the share payload carries at least one file. */
  hasFiles: boolean;
}): ShareDestinationAdmission {
  if (input.createdOnPlatform !== 'cli') {
    return { ok: true };
  }

  if (!input.live) {
    return {
      ok: false,
      title: 'Session not connected',
      message:
        "This session runs on a Kilo CLI that isn't connected, so it can't receive messages right now. Reconnect the CLI on that machine, or pick another session.",
    };
  }

  if (input.hasFiles && !input.attachmentsCapable) {
    return {
      ok: false,
      title: "This session can't receive files",
      message:
        "The Kilo CLI running this session can't receive files. Update the CLI on that machine, or share to a new session instead.",
    };
  }

  return { ok: true };
}
