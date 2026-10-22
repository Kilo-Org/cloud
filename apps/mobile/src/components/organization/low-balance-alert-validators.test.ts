import { describe, expect, it } from 'vitest';

import {
  emailsError,
  parseEmails,
  saveErrorCopy,
} from '@/components/organization/low-balance-alert-validators';
import { i18n } from '@/i18n';

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
});
