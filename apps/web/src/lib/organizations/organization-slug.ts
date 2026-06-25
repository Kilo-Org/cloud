import { ORGANIZATION_SLUG_MAX_LENGTH } from '@/lib/organizations/organization-route-utils';

export const ORGANIZATION_SLUG_COLLISION_SUFFIX_LENGTH = 3;

const ORGANIZATION_SLUG_FALLBACK_BASE = 'org';
const ORGANIZATION_SLUG_SUFFIX_SEPARATOR_LENGTH = 1;

function truncateSlug(slug: string, maxLength: number): string {
  const truncated = slug.slice(0, maxLength).replace(/-+$/g, '');
  return truncated || ORGANIZATION_SLUG_FALLBACK_BASE;
}

export function normalizeOrganizationSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/3/g, 'e')
    .replace(/[.\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return truncateSlug(slug || ORGANIZATION_SLUG_FALLBACK_BASE, ORGANIZATION_SLUG_MAX_LENGTH);
}

export function appendOrganizationSlugCollisionSuffix(slug: string, suffix: string): string {
  const baseMaxLength =
    ORGANIZATION_SLUG_MAX_LENGTH -
    ORGANIZATION_SLUG_SUFFIX_SEPARATOR_LENGTH -
    ORGANIZATION_SLUG_COLLISION_SUFFIX_LENGTH;
  const base = truncateSlug(slug, baseMaxLength);
  return `${base}-${suffix}`;
}
