import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import {
  findOrganizationByRouteIdentifier,
  getOrganizationAppPath,
  getOrganizationAppPathForRouteIdentifier,
  getOrganizationRouteIdentifier,
  isOrganizationRouteIdentifierMatch,
  isValidOrganizationRouteIdentifier,
  isUuidOrganizationRouteIdentifier,
  ORGANIZATION_SLUG_MAX_LENGTH,
} from './organization-route-utils';
import {
  resolveOrganizationRouteIdentifierDetails,
  resolveOrganizationRouteIdentifier,
} from './organization-route-utils.server';

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

describe('organization app paths', () => {
  it('uses the slug in organization app paths when one exists', () => {
    expect(getOrganizationAppPath({ id: 'org-id', slug: 'acme' }, '/payment-details')).toBe(
      '/organizations/acme/payment-details'
    );
  });

  it('falls back to the organization id in app paths when no slug exists', () => {
    expect(getOrganizationAppPath({ id: 'org-id', slug: null })).toBe('/organizations/org-id');
  });

  it('encodes explicit route identifiers', () => {
    expect(getOrganizationAppPathForRouteIdentifier('acme inc', 'code-reviews')).toBe(
      '/organizations/acme%20inc/code-reviews'
    );
  });
});

describe('organization route identifier matching', () => {
  const organizationsForRouteMatching = [
    { id: '550e8400-e29b-41d4-a716-446655440000', slug: 'acme' },
    { id: '550e8400-e29b-41d4-a716-446655440001', slug: null },
  ];

  it('matches organizations by slug or id', () => {
    expect(isOrganizationRouteIdentifierMatch(organizationsForRouteMatching[0], 'acme')).toBe(true);
    expect(
      isOrganizationRouteIdentifierMatch(
        organizationsForRouteMatching[0],
        '550e8400-e29b-41d4-a716-446655440000'
      )
    ).toBe(true);
  });

  it('finds an organization by slug route identifier', () => {
    expect(findOrganizationByRouteIdentifier(organizationsForRouteMatching, 'acme')).toEqual(
      organizationsForRouteMatching[0]
    );
  });

  it('finds an organization by id route identifier', () => {
    expect(
      findOrganizationByRouteIdentifier(
        organizationsForRouteMatching,
        '550e8400-e29b-41d4-a716-446655440001'
      )
    ).toEqual(organizationsForRouteMatching[1]);
  });

  it('returns null when there is no route identifier', () => {
    expect(findOrganizationByRouteIdentifier(organizationsForRouteMatching, null)).toBeNull();
  });

  it('detects UUID route identifiers', () => {
    expect(isUuidOrganizationRouteIdentifier('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isUuidOrganizationRouteIdentifier('acme')).toBe(false);
  });

  it('validates slug route identifiers using the persisted slug format', () => {
    expect(isValidOrganizationRouteIdentifier('acme')).toBe(true);
    expect(isValidOrganizationRouteIdentifier('acme-')).toBe(true);
    expect(isValidOrganizationRouteIdentifier('a'.repeat(32))).toBe(true);
    expect(isValidOrganizationRouteIdentifier('a'.repeat(33))).toBe(false);
    expect(isValidOrganizationRouteIdentifier('acme_inc')).toBe(false);
  });
});

describe('resolveOrganizationRouteIdentifier', () => {
  afterEach(async () => {
    await db
      .delete(organizations)
      .where(
        inArray(organizations.slug, [
          'route-id-org',
          'route-slug-org',
          'route-slug-ending-hyphen-',
          'deleted-route-org',
          'persisted-kilocode-org',
        ])
      );
  });

  it('resolves organization ids', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Route ID Org', slug: 'route-id-org' })
      .returning();

    await expect(resolveOrganizationRouteIdentifier(organization.id)).resolves.toBe(
      organization.id
    );
  });

  it('resolves organization slugs', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Route Slug Org', slug: 'route-slug-org' })
      .returning();

    await expect(resolveOrganizationRouteIdentifier('route-slug-org')).resolves.toBe(
      organization.id
    );
  });

  it('resolves persisted slugs ending with hyphen', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Route Slug Ending Hyphen Org', slug: 'route-slug-ending-hyphen-' })
      .returning();

    await expect(resolveOrganizationRouteIdentifier('route-slug-ending-hyphen-')).resolves.toBe(
      organization.id
    );
  });

  it('resolves already persisted slugs containing reserved terms', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Persisted Kilo Slug Org', slug: 'persisted-kilocode-org' })
      .returning();

    await expect(resolveOrganizationRouteIdentifier('persisted-kilocode-org')).resolves.toBe(
      organization.id
    );
  });

  it('returns the canonical route identifier', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Route Slug Org', slug: 'route-slug-org' })
      .returning();

    await expect(resolveOrganizationRouteIdentifierDetails(organization.id)).resolves.toEqual({
      id: organization.id,
      slug: 'route-slug-org',
      routeIdentifier: 'route-slug-org',
    });
  });

  it('does not resolve deleted organizations', async () => {
    await db.insert(organizations).values({
      name: 'Deleted Route Org',
      slug: 'deleted-route-org',
      deleted_at: new Date().toISOString(),
    });

    await expect(resolveOrganizationRouteIdentifier('deleted-route-org')).resolves.toBeNull();
  });
});
