import { describe, expect, it } from 'vitest';

import { emailsError } from '@/components/organization/low-balance-alert-validators';

describe('emailsError', () => {
  it('fails the whole list when any email is malformed', () => {
    expect(emailsError('a@x.com, not-an-email')).not.toBeNull();
  });
});
