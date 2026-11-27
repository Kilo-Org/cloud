// The reviewed row table of the runtime copier (M122): worker | binding | store/secret | Infisical
// target. Each row copies one production Secrets Store binding of one source Worker into one
// Create-only Infisical production target. secrets-cutover posts the rows in
// ~/.omp/progress/secrets-phase234-files/coordination.md; each change is a reviewed edit of this
// file plus, for a new Worker, its checks.mjs `WORKER_SOURCES` entry. Never a runtime parameter.
//
// Until that table arrives the only row is the Notifications Expo token (M108). Remove that row if
// the one-shot Expo run has already created its target: Create-only refuses an existing target.

import { batchesOf, validateTable } from './core.mjs';

export const ROWS = Object.freeze(
  [
    {
      worker: 'notifications',
      binding: 'EXPO_ACCESS_TOKEN',
      storeId: '342a86d9e3a94da698e82d0c6e2a36f0',
      secretName: 'EXPO_ACCESS_TOKEN',
      target: '/workloads/notifications/NOTIFICATIONS_EXPO_ACCESS_TOKEN',
    },
  ].map(r => Object.freeze(r))
);

/** Names-only problems of the table; any problem leaves BATCHES empty, so nothing can run. */
export const TABLE_PROBLEMS = Object.freeze(validateTable(ROWS));

/** One reviewed batch per source Worker, keyed by Worker name. */
export const BATCHES =
  TABLE_PROBLEMS.length === 0 ? batchesOf(ROWS) : Object.freeze(Object.create(null));

/** The source Workers in table order: the workflow's matrix, run one at a time. */
export const WORKERS = Object.freeze(Object.keys(BATCHES));
