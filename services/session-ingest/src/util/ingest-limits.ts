// Durable Object SQL storage limits the maximum size of a string/BLOB/row to 2MiB.
// Use a safety margin so the stored row (which includes other columns/overhead)
// cannot exceed the platform limit.
export const MAX_INGEST_ITEM_BYTES = 2 * 1024 * 1024 - 64 * 1024;

// Items above this byte count are skipped during queue processing.
// Tracked incrementally during streaming parse — item is aborted as soon as it exceeds this.
export const MAX_SINGLE_ITEM_BYTES = 50 * 1024 * 1024;

// Shared policy for keeping one ingest RPC within conservative payload bounds.
export const INGEST_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
export const INGEST_CHUNK_MAX_ITEMS = 128;

// Largest body the request handler accepts before staging. Matches the queue
// consumer's per-item cap, so a payload the consumer is built to chunk is never
// rejected at the edge; large bodies cross as a counting stream, so memory
// stays flat regardless of size.
export const STAGING_MAX_BYTES = MAX_SINGLE_ITEM_BYTES;
