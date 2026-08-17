/**
 * Terminal export failures: conditions a retry cannot resolve.
 *
 * The queue consumer retries any other error up to `max_retries` before dead-lettering,
 * which is the right default for a transient database or R2 fault. An error raised here
 * instead marks the export failed on the first attempt and surfaces `redactedMessage` to
 * the requester, so a permanent condition fails honestly rather than after several
 * minutes of retries that were never going to succeed.
 *
 * Lives in its own module because both the worker and the source adapters raise these,
 * and the worker already imports the adapters.
 */
export class TerminalExportError extends Error {
  constructor(
    readonly failureCode: string,
    readonly redactedMessage: string,
    message: string
  ) {
    super(message);
    this.name = 'TerminalExportError';
  }
}
