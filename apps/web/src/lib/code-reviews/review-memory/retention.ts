export const REVIEW_MEMORY_RETENTION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const REVIEW_MEMORY_RETENTION_LABEL = `${REVIEW_MEMORY_RETENTION_DAYS}-day retention`;

export const REVIEW_MEMORY_RETENTION_COPY = `Kilo keeps review feedback for ${REVIEW_MEMORY_RETENTION_DAYS} days. Feedback that does not become REVIEW.md guidance is removed automatically.`;

export function reviewMemoryRetentionCutoff(now = new Date()): string {
  return new Date(now.getTime() - REVIEW_MEMORY_RETENTION_DAYS * MS_PER_DAY).toISOString();
}
