/**
 * D1's ceiling on bound parameters in one statement (platform limits: "Maximum bound
 * parameters per query: 100"). Lives in its own module because the statement builders and the
 * modules that batch rows both need it, and importing it through `db.ts` would cycle back.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Slots one staging batch may name, and the store's per-batch case cap.
 *
 * A slice's binding count is flat: the case and repetition lists travel as one JSON parameter
 * each, so the widest statement in a batch binds nine values (`enqueuePaidCaseBatchStatements`:
 * request id, five key columns, the covered bit, the timestamp, the request id again) whatever
 * the slice names, and D1's 100-parameter ceiling is not what bounds it. 88 is chosen as a
 * transaction size: one batch writes at most ~176 rows, its case-list parameter is about 22 KB
 * (comfortably inside D1's 2 MB row/value limit and the 1 MB query limit), and a wide plan is
 * paged over many small transactions instead of one long one. It is deliberately not larger:
 * staging already spends the tick's budget in bounded batches, and a smaller batch keeps each
 * write short for D1's single-threaded queue.
 */
export const STAGE_SLICE_MAX_SLOTS = 88;
