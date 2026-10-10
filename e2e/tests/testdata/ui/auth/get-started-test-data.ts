/** Paths and responses for the `/get-started` auth-aware router spec. */
export const getStartedPaths = {
  getStarted: '/get-started',
  /** Where a signed-out visitor is redirected (the landing site's install page). */
  install: '/install',
};

/** A signed-in visitor lands on `/profile` or on an `/organizations/...` page. */
export const signedInDestinationRegExp = /^https?:\/\/[^/]+\/(profile([?#]|$)|organizations\/)/;

export const redirectStatuses = [307, 308];
