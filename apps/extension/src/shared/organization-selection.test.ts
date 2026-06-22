import { describe, expect, it } from 'vitest';
import { getSelectableOrganizationId } from './organization-selection';

describe('organization selection', () => {
  it('clears a selected organization that is no longer available', () => {
    expect(
      getSelectableOrganizationId({
        organizations: [{ id: 'org-2', name: 'Other org' }],
        selectedOrganizationId: 'org-1',
        storedOrganizationId: 'org-1',
      })
    ).toBe('');
  });

  it('keeps a selected organization that is still available', () => {
    expect(
      getSelectableOrganizationId({
        organizations: [{ id: 'org-1', name: 'Acme' }],
        selectedOrganizationId: 'org-1',
        storedOrganizationId: null,
      })
    ).toBe('org-1');
  });
});
