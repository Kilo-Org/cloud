/**
 * The rules a download code is checked against before and after the round trip.
 *
 * Kept apart from the download itself, which pulls in the platform file system:
 * these are pure, so a screen test can exercise them without an Expo runtime.
 */
/** The shape the server accepts for a download code: exactly eight digits. */
export const DOWNLOAD_CODE_PATTERN = /^\d{8}$/;

/**
 * What to show when a download call fails. A rejected input arrives as the
 * serialized issue list of the request schema, which is not something a reader
 * should see, so a payload like that is replaced with the caller's own copy.
 */
export function codeFailureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.startsWith('[') || error.message.startsWith('{')) {
    return fallback;
  }
  return error.message;
}
