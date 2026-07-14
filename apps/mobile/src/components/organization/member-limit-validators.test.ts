import { describe, expect, it } from 'vitest';

import { limitError } from '@/components/organization/member-limit-validators';

describe('limitError', () => {
  it('disables save on a blank field instead of treating it as "remove"', () => {
    expect(limitError('')).not.toBeNull();
    expect(limitError('   ')).not.toBeNull();
  });
});
