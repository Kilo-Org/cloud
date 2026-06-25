import { getUrlOrganizationIdentifier } from './useUrlOrganizationId';

describe('getUrlOrganizationIdentifier', () => {
  it('extracts UUID organization route identifiers', () => {
    expect(
      getUrlOrganizationIdentifier('/organizations/550e8400-e29b-41d4-a716-446655440000')
    ).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('extracts slug organization route identifiers', () => {
    expect(getUrlOrganizationIdentifier('/organizations/acme-inc/claw/chat')).toBe('acme-inc');
  });

  it('decodes route identifiers before using them as organization context keys', () => {
    expect(getUrlOrganizationIdentifier('/organizations/acme%2Dinc/payment-details')).toBe(
      'acme-inc'
    );
  });

  it('returns null outside organization routes', () => {
    expect(getUrlOrganizationIdentifier('/profile')).toBeNull();
  });
});
