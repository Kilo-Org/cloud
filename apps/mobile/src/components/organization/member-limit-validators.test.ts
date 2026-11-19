import { describe, expect, it } from 'vitest';

import { limitError, saveErrorCopy } from '@/components/organization/member-limit-validators';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

const max = formatNumber(2000, i18n.language);
const rangeMessage = i18n.t('organization.memberLimit.rangeError', { max });

describe('limitError', () => {
  it('disables save on a blank field instead of treating it as "remove"', () => {
    expect(limitError('', true)).not.toBeNull();
    expect(limitError('   ', true)).not.toBeNull();
  });

  it('names the allowed range on a blank field when there is no limit to remove', () => {
    expect(limitError('', false)).toBe(
      i18n.t('organization.memberLimit.blankWithoutLimitError', { max })
    );
  });

  it('keeps the removal hint on a blank field when the limit can be removed', () => {
    expect(limitError('', true)).toBe(i18n.t('organization.memberLimit.blankError'));
  });

  it('accepts both ends of the allowed range', () => {
    expect(limitError('0', true)).toBeNull();
    expect(limitError('2000', true)).toBeNull();
  });

  it('names the same range the validator enforces for a value above it', () => {
    expect(limitError('2500', true)).toBe(rangeMessage);
    expect(limitError('2000.01', false)).toBe(rangeMessage);
  });

  it('rejects a negative and an unparseable amount with the range message', () => {
    expect(limitError('-1', true)).toBe(rangeMessage);
    expect(limitError('lots', true)).toBe(rangeMessage);
  });

  it('accepts Arabic-Indic digits typed under the Arabic UI', async () => {
    await i18n.changeLanguage('ar');
    try {
      expect(limitError('٢٥', true)).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('saveErrorCopy', () => {
  it('places a schema rejection on the field with the range the rule enforces', () => {
    const error = Object.assign(new Error('[]'), { data: { code: 'BAD_REQUEST' } });
    expect(saveErrorCopy(error)).toEqual({ field: 'limit', message: rangeMessage });
  });

  it('never echoes the server message, which is a JSON issue array', () => {
    const raw = '[{"code":"too_big","path":["dailyUsageLimitUsd"],"message":"Too big"}]';
    const copy = saveErrorCopy(Object.assign(new Error(raw), { data: { code: 'BAD_REQUEST' } }));
    expect(copy.message).not.toContain('too_big');
    expect(copy.message).not.toContain('dailyUsageLimitUsd');
    expect(copy.message).not.toContain('Too big');
  });

  it('falls back to the settings line for a failure that is not a schema rejection', () => {
    const generic = { field: 'form', message: i18n.t('common.couldNotSaveSetting') };
    expect(saveErrorCopy(new Error('Failed to fetch'))).toEqual(generic);
    expect(
      saveErrorCopy(Object.assign(new Error('boom'), { data: { code: 'FORBIDDEN' } }))
    ).toEqual(generic);
  });

  it('gives a billing role the plan refusal that offers the step', () => {
    const error = Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
      data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE },
    });
    expect(saveErrorCopy(error, true)).toEqual({
      field: 'form',
      message: i18n.t('common.organizationTrialEndedBilling'),
    });
    // The reader who cannot change the plan keeps the copy that names the owner.
    expect(saveErrorCopy(error, false)).toEqual({
      field: 'form',
      message: i18n.t('common.organizationTrialEnded'),
    });
  });
});
