const LOCAL_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isLocalCodeReviewFakeProviderEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;

  const value = process.env.CODE_REVIEW_LOCAL_FAKE_PROVIDER?.trim().toLowerCase();
  return value !== undefined && LOCAL_TRUE_VALUES.has(value);
}
