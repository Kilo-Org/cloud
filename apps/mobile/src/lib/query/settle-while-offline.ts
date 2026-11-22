/**
 * Read options for a query whose answer must settle even while the online
 * manager reports offline.
 *
 * NetInfo can hold the device offline while the backend is reachable. A read on
 * the default `networkMode: 'online'` then pauses in `pending`: it sends no
 * request, reaches no error, and reports `isLoading` false, so a surface that
 * waits on it shows neither content nor a retry, and an auto-selection or gate
 * derived from it waits on a value that never arrives. With this policy the
 * read either answers or fails once the control-plane deadline lands.
 *
 * `networkMode: 'always'` also flips the derived reconnect refetch off
 * (`@tanstack/query-core` sets `refetchOnReconnect = networkMode !== 'always'`),
 * so ask for it back explicitly.
 */
export const SETTLE_WHILE_OFFLINE = {
  networkMode: 'always',
  refetchOnReconnect: true,
} as const;

/**
 * Write options for a mutation that must be attempted even while the online
 * manager reports offline.
 *
 * A tap on a write is an outcome to attempt, not a precondition to wait for.
 * On the default `networkMode: 'online'` the mutation pauses while NetInfo holds
 * the device offline: no request is sent, the mutation never settles, no
 * `onError` and no inline `isError` surface runs, and the queued write lands
 * silently once the connection returns. Attempting it instead fails through the
 * mutation's normal path, so the caller sees the rejection and its failure copy.
 *
 * Mutation options carry no reconnect refetch, so this holds the network mode
 * alone; `SETTLE_WHILE_OFFLINE` above keeps its own pair for the reads that do.
 */
export const MUTATE_WHILE_OFFLINE = { networkMode: 'always' } as const;
