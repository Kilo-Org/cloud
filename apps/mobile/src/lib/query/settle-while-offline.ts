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
