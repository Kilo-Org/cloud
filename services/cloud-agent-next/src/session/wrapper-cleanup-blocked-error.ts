export type WrapperCleanupBlock = { kind: 'retryable'; retryAt: number } | { kind: 'exhausted' };

export class WrapperCleanupBlockedError extends Error {
  constructor(readonly block: WrapperCleanupBlock) {
    super('Wrapper cleanup is required before delivery can launch');
    this.name = 'WrapperCleanupBlockedError';
  }
}
