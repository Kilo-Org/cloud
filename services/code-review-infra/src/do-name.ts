export function doNameForAttempt(reviewId: string, attemptId?: string): string {
  return attemptId ? `${reviewId}:${attemptId}` : reviewId;
}
