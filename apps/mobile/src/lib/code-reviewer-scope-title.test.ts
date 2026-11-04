import { describe, expect, it } from 'vitest';

import { reviewerScopeTitle } from './code-reviewer-scope-title';

const labels = { personal: 'Personal', organization: 'Organization' };
const organizations = [{ organizationId: 'org-labs', organizationName: 'Drain Labs' }];

describe('reviewerScopeTitle', () => {
  it('names the personal scope', () => {
    expect(reviewerScopeTitle('personal', organizations, labels)).toBe('Personal');
  });

  it('names an organization scope from its membership row', () => {
    expect(reviewerScopeTitle('org-labs', organizations, labels)).toBe('Drain Labs');
  });

  it('keeps the generic label until the membership list names the scope', () => {
    expect(reviewerScopeTitle('org-labs', undefined, labels)).toBe('Organization');
    expect(reviewerScopeTitle('org-gone', organizations, labels)).toBe('Organization');
  });
});
