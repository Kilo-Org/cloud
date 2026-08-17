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

/**
 * A failure reading ONE source, wrapped so the generator can tell it apart from a failure
 * of the export itself.
 *
 * The two are otherwise indistinguishable at the point they surface: a page reads from the
 * warehouse and writes to the compressor inside one span, so an error escaping it could be
 * either a bad table or a broken output stream. Treating them alike would be wrong in both
 * directions — a broken stream would be reported as every source failing in turn, and a
 * single unreadable table would abort an export that could have completed without it.
 *
 * Only the read is wrapped in this. Anything thrown by the write path stays bare and stays
 * fatal, because a stream that cannot be written to has no next source to move on to.
 */
export class SourceReadError extends Error {
  constructor(
    readonly source: string,
    readonly cause: unknown
  ) {
    super(`Failed reading export source ${source}`);
    this.name = 'SourceReadError';
  }
}
