/**
 * D1's ceiling on bound parameters in one statement (platform limits: "Maximum bound
 * parameters per query: 100"). This lives in its own module because both the statement
 * builders and the modules that batch rows need it, and importing it through `db.ts` would
 * cycle back into the statement builders.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;
