import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import {
  getOrganizationRouteIdentifier,
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

describe('resolveOrganizationRouteIdentifier', () => {
  afterEach(async () => {
    await db
      .delete(organizations)
      .where(inArray(organizations.slug, ['route-id-org', 'route-slug-org', 'deleted-route-org']));
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
