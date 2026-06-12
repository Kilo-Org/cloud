export class WrapperCleanupBlockedError extends Error {
  constructor(readonly retryAt: number) {
    super('Wrapper cleanup is required before delivery can launch');
    this.name = 'WrapperCleanupBlockedError';
  }
}
