/**
 * D1's platform limits that bound this service's batched statements.
 *
 * They live in their own module because both the statement builders and the modules that
 * batch rows need them, and importing them through `db.ts` would cycle back into the builders.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** D1's ceiling on one statement's text: "Maximum SQL statement length" (100 KB). */
export const D1_MAX_STATEMENT_BYTES = 100_000;

/**
 * A safe upper bound on one staged case entry inside a batch's JSON case list: the engine
 * identity (a 64-character hash), the model, variant, repetition, case id, the covered bit
 * and the JSON keys that name them.
 */
export const STAGE_CASE_ENTRY_BYTES = 256;

/**
 * Slots one staging batch may name, and the store's per-batch case cap.
 *
 * Binding counts do not grow with the slice: `paidReuseDrawsSql`, `paidPendingOutputsSql` and
 * `readOpenCaseRuns` bind their case and repetition lists as one JSON array each, so the
 * widest statement in a batch binds nine parameters whatever the slice names (the case-row
 * insert's `{ requestId, five key columns, covered, at, requestId }`). What does grow is that
 * batch's JSON case list, inside D1's `D1_MAX_STATEMENT_BYTES` ceiling: at
 * `STAGE_CASE_ENTRY_BYTES` that allows `floor(100,000 / 256) = 390` slots. The slice is capped
 * far below that at 88, so one batch is a ~10 KB statement with room to spare and staging is
 * paged in small transactions rather than one long one.
 */
export const STAGE_SLICE_MAX_SLOTS = 88;
