import type { EnkryptFailureCategory, EnkryptSyncCounts } from '@kilocode/db/schema-types';

export class EnkryptSyncError extends Error {
  readonly category: EnkryptFailureCategory;
  readonly counts: EnkryptSyncCounts | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    category: EnkryptFailureCategory,
    options: { counts?: EnkryptSyncCounts; httpStatus?: number } = {}
  ) {
    super('Enkrypt synchronization failed');
    this.name = 'EnkryptSyncError';
    this.category = category;
    this.counts = options.counts;
    this.httpStatus = options.httpStatus;
  }
}
