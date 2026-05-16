/**
 * Shared error type for the wanted-board ops layer.
 *
 * Lives in a dedicated module (rather than inside `wanted-board-ops.ts`)
 * so the SDK adapter can throw the same error class without dragging
 * `wanted-board-ops.ts`'s libwl runtime imports into modules that are
 * unit-tested in the Node vitest pool.
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
