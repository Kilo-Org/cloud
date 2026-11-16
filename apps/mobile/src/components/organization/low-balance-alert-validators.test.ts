import { describe, expect, it } from 'vitest';

import {
  emailsError,
  parseEmails,
  parseThreshold,
  saveErrorCopy,
  thresholdError,
} from '@/components/organization/low-balance-alert-validators';
import { i18n } from '@/i18n';
import { formatCurrency } from '@/lib/format';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

// `pnpm check:i18n` owns the copy; these assert which sentence a value earns,
// echoing the spending-alert’s fixture instead of repeating the wording here.
const CAP_SENTENCE = i18n.t('spendAlerts.thresholdMaxError', {
  max: formatCurrency(1_000_000_000, i18n.language, 0),
});
const GREATER_THAN_ZERO_SENTENCE = i18n.t('organization.lowBalanceAlert.thresholdError');

describe('emailsError', () => {
  const invalidCopy = i18n.t('organization.lowBalanceAlert.emailsInvalid');

  it('asks for an address when the field holds no entry', () => {
    expect(emailsError('')).toBe(i18n.t('organization.lowBalanceAlert.emailsRequired'));
    expect(emailsError(' , ,')).toBe(i18n.t('organization.lowBalanceAlert.emailsRequired'));
  });

  it('reports a malformed entry in a list of valid ones without repeating the comma hint', () => {
    const message = emailsError('one@example.com, two@example.com, broken-address');
    expect(message).toBe(invalidCopy);
    expect(message).not.toContain(i18n.t('organization.lowBalanceAlert.separateEmailsHint'));
  });

  it('rejects entries the server schema rejects even though they contain an at-sign and a dot', () => {
    // The address shape the recipient field used to accept: the old pattern
    // only required text around an @ and a dot, so the server rejected these
    // after Save instead of the field reporting them here.
    for (const entry of ['a😀@example.com', 'sample@example..com', 'user@例え.jp']) {
      expect(emailsError(`one@example.com, ${entry}`)).toBe(invalidCopy);
    }
  });

  it('accepts every entry of a valid list', () => {
    const value = 'one@example.com, first.last+tag@sub.example.co.uk';
    expect(emailsError(value)).toBeNull();
    expect(parseEmails(value)).toEqual(['one@example.com', 'first.last+tag@sub.example.co.uk']);
  });
});

describe('saveErrorCopy', () => {
  it('places a schema rejection on the recipient field', () => {
    const error = Object.assign(new Error('[]'), { data: { code: 'BAD_REQUEST' } });
    expect(saveErrorCopy(error)).toEqual({
      field: 'emails',
      message: i18n.t('organization.lowBalanceAlert.saveEmailsError'),
    });
  });

  it('never echoes the server message, which is a JSON issue array', () => {
    const raw =
      '[{"validation":"email","code":"invalid_format","path":["minimum_balance_alert_email"]}]';
    const error = Object.assign(new Error(raw), { data: { code: 'BAD_REQUEST' } });
    const copy = saveErrorCopy(error);
    expect(copy.message).not.toContain('invalid_format');
    expect(copy.message).not.toContain('minimum_balance_alert_email');
  });

  it('falls back to the form-level line for a failure that is not a schema rejection', () => {
    expect(saveErrorCopy(new Error('Failed to fetch'))).toEqual({
      field: 'form',
      message: i18n.t('organization.lowBalanceAlert.saveError'),
    });
    expect(
      saveErrorCopy(Object.assign(new Error('boom'), { data: { code: 'INTERNAL_SERVER_ERROR' } }))
    ).toEqual({
      field: 'form',
      message: i18n.t('organization.lowBalanceAlert.saveError'),
    });
  });

  it('names a lapsed organization plan on the form line', () => {
    const error = Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
      data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE },
    });
    expect(saveErrorCopy(error)).toEqual({
      field: 'form',
      message: i18n.t('common.organizationTrialEnded'),
    });
  });
});

describe('thresholdError', () => {
  it('names the maximum once the value can no longer be a saved balance', () => {
    // A pasted literal longer than a JS number still reads as Infinity, a
    // number, and one far above the cap; it must not be reported as "enter an
    // amount greater than 0". One over the cap earns the same sentence.
    for (const value of ['1'.repeat(300), '1000000001']) {
      expect(thresholdError(value)).toBe(CAP_SENTENCE);
      expect(thresholdError(value)).not.toBe(GREATER_THAN_ZERO_SENTENCE);
    }
  });

  it('reads a value at the cap and a fractional balance as valid', () => {
    for (const value of ['1000000000', '250.5']) {
      expect(thresholdError(value)).toBeNull();
      expect(parseThreshold(value)).not.toBeNull();
    }
  });

  it('parses nothing outside the bounds, never a clamped amount', () => {
    for (const value of ['1'.repeat(300), '1000000001']) {
      expect(parseThreshold(value)).toBeNull();
    }
  });

  it('keeps the "greater than 0" copy for empty, unparsable, and non-positive values', () => {
    for (const value of ['', '0', '-5', 'abc']) {
      expect(thresholdError(value)).toBe(GREATER_THAN_ZERO_SENTENCE);
      expect(parseThreshold(value)).toBeNull();
    }
  });
});
