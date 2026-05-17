/**
 * Shared error type for the wanted-board ops layer.
 *
 * Code maps roughly to HTTP/tRPC error codes; callers translate as needed.
 */

export class WantedBoardOpError extends Error {
  constructor(
    message: string,
    /** Maps roughly to HTTP/tRPC codes. Callers translate as needed. */
    readonly code: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR' | 'UPSTREAM_ERROR'
  ) {
    super(message);
    this.name = 'WantedBoardOpError';
  }
}
