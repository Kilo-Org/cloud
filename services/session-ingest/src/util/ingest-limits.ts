// Durable Object SQL storage limits the maximum size of a string/BLOB/row to 2MiB.
// Use a safety margin so the stored row (which includes other columns/overhead)
// cannot exceed the platform limit.
export const MAX_INGEST_ITEM_BYTES = 2 * 1024 * 1024 - 64 * 1024;

// Items above this byte count are skipped during queue processing.
// Tracked incrementally during streaming parse — item is aborted as soon as it exceeds this.
export const MAX_SINGLE_ITEM_BYTES = 50 * 1024 * 1024;
