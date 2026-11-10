// Intent-agnostic pieces of the operation ledger (P1-A-08). Every ledgered
// mutation — PR review, security sync, finding dismissal, session spawn —
// hoists one operation key per intent and receives the same raw server markers.
//
// Only the RAW markers live here. The user-facing copy for each marker is
// per-surface by design, so each surface maps these markers onto its own
// message instead of sharing one.
//
// This module is pure on purpose: no React and no native imports, so a pure
// Node test of any ledger helper can load it without a stub.

/** The ledger rejected a same-key request while the first one is still in flight. */
export const OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
/** The key was reused for a different intent, so the ledger refused to replay it. */
export const OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';

/** True when the failure is the in-flight duplicate marker. */
export function isOperationInProgress(error: unknown): boolean {
  return error instanceof Error && error.message === OPERATION_IN_PROGRESS_MESSAGE;
}
