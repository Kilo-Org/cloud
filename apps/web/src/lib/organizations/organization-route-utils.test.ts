import { describe, expect, it } from '@jest/globals';
import {
  getOrganizationRouteIdentifier,
  ORGANIZATION_SLUG_MAX_LENGTH,
} from './organization-route-utils';

describe('getOrganizationRouteIdentifier', () => {
  it('uses the slug when one exists', () => {
    expect(getOrganizationRouteIdentifier({ id: 'org-id', slug: 'acme' })).toBe('acme');
  });

  it('falls back to the organization id when no slug exists', () => {
    expect(getOrganizationRouteIdentifier({ id: 'org-id', slug: null })).toBe('org-id');
  });

  it('exports the organization slug route length', () => {
    expect(ORGANIZATION_SLUG_MAX_LENGTH).toBe(32);
  });
});
