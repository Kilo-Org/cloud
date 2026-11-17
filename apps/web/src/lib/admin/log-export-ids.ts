/** Keeps a download URL with both lists full well below Vercel's 14 KB request URL limit. */
export const MAX_LOG_EXPORT_IDS = 100;

/** Splits a list of IDs separated by commas, spaces or newlines, dropping empty entries and duplicates. */
export function splitIdList(...values: string[]): string[] {
  return [...new Set(values.flatMap(value => value.split(/[\s,]+/)).filter(Boolean))];
}
