/**
 * Thrown by a platform's `beginLinkAccountProof` hook when its identity proof
 * cannot start, for example because the provider client is not configured. The
 * generic link route turns it into a page instead of a crash.
 */
export class LinkAccountProofUnavailableError extends Error {
  constructor(message = 'Account linking is not available right now.') {
    super(message);
    this.name = 'LinkAccountProofUnavailableError';
  }
}
