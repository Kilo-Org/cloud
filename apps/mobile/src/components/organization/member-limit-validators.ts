import { i18n } from '@/i18n';
import { formatNumber, parseLocalizedNumber } from '@/lib/format';

const MAX_DAILY_LIMIT_USD = 2000;

// A blank field disables Save — it does NOT remove the limit. Removal only
// happens via the explicit "Remove limit" button, so clearing the input by
// mistake can never silently drop a configured money limit on Save.
export function limitError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return i18n.t('organization.memberLimit.blankError');
  }
  const parsed = parseLocalizedNumber(trimmed, i18n.language);
  if (parsed === null || parsed < 0 || parsed > MAX_DAILY_LIMIT_USD) {
    return i18n.t('organization.memberLimit.rangeError', {
      max: formatNumber(MAX_DAILY_LIMIT_USD, i18n.language),
    });
  }
  return null;
}

export function parseLimit(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : parseLocalizedNumber(trimmed, i18n.language);
}
