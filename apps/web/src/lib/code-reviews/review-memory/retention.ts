export const REVIEW_MEMORY_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function reviewMemoryRetentionCutoff(now = new Date()): string {
  return new Date(now.getTime() - REVIEW_MEMORY_RETENTION_DAYS * MS_PER_DAY).toISOString();
}
