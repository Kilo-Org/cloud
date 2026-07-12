const MAX_DAILY_LIMIT_USD = 2000;
const LIMIT_RANGE_ERROR = `Enter an amount between 0 and ${MAX_DAILY_LIMIT_USD}`;
const LIMIT_BLANK_ERROR = 'Enter an amount, or use Remove limit below';

// A blank field disables Save — it does NOT remove the limit. Removal only
// happens via the explicit "Remove limit" button, so clearing the input by
// mistake can never silently drop a configured money limit on Save.
export function limitError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return LIMIT_BLANK_ERROR;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_DAILY_LIMIT_USD) {
    return LIMIT_RANGE_ERROR;
  }
  return null;
}

export function parseLimit(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}
