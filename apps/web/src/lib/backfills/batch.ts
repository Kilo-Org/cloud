export const BACKFILL_BATCH_SIZE = 1000;
export const BACKFILL_BATCHES_PER_REQUEST = 50;

export type BackfillBatchResult = {
  processed: number;
  remaining: boolean;
};
