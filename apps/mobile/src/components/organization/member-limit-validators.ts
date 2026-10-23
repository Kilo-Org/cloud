import { i18n } from '@/i18n';
import { formatNumber, parseLocalizedNumber } from '@/lib/format';
import { readTrpcErrorField } from '@/lib/trpc-error';

const MAX_DAILY_LIMIT_USD = 2000;

// A blank field disables Save — it does NOT remove the limit. Removal only
// happens via the explicit "Remove limit" button, so clearing the input by
// mistake can never silently drop a configured money limit on Save.
export function limitError(value: string, hasCurrentLimit: boolean): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    // Only a member that already has a limit sees the "Remove limit" button, so
    // the blank message must not point at it when the button is absent.
    return hasCurrentLimit
      ? i18n.t('organization.memberLimit.blankError')
      : i18n.t('organization.memberLimit.blankWithoutLimitError', {
          max: formatNumber(MAX_DAILY_LIMIT_USD, i18n.language),
        });
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

/** Where a failed save belongs and what it says, both localized. */
export type SaveErrorCopy = Readonly<{
  field: 'limit' | 'form';
  message: string;
}>;

/**
 * A save rejected by the input schema is a value outside the allowed range, so
 * it belongs on the field, with the sentence the field's own rule uses. Every
 * other failure — transport, permission, a member that is gone — gets the
 * settings line. The raw server message never reaches the UI: a schema
 * rejection carries a JSON array of zod issues, not a sentence.
 */
export function saveErrorCopy(error: unknown): SaveErrorCopy {
  if (readTrpcErrorField(error, 'code') === 'BAD_REQUEST') {
    return {
      field: 'limit',
      message: i18n.t('organization.memberLimit.rangeError', {
        max: formatNumber(MAX_DAILY_LIMIT_USD, i18n.language),
      }),
    };
  }
  return { field: 'form', message: i18n.t('common.couldNotSaveSetting') };
}
