/**
 * The control plane's pending-interaction projection could not be read. The ask
 * may still be pending, so this failure is retryable. It is not the empty
 * projection, which reads as no pending request.
 */
export class PendingPermissionUnreadableError extends Error {
  constructor() {
    super('The cloud-agent pending-interaction projection could not be read');
    this.name = 'PendingPermissionUnreadableError';
  }
}
