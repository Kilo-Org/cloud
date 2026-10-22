import { describe, expect, it } from 'vitest';

import { limitError } from '@/components/organization/member-limit-validators';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

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
});
