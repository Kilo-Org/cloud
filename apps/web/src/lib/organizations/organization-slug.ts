import { ORGANIZATION_SLUG_MAX_LENGTH } from '@/lib/organizations/organization-route-utils';

export const ORGANIZATION_SLUG_COLLISION_SUFFIX_LENGTH = 3;

const ORGANIZATION_SLUG_SUFFIX_SEPARATOR_LENGTH = 1;
const ORGANIZATION_SLUG_RESERVED_SUBSTRINGS = ['kilo'];
const ORGANIZATION_SLUG_FALLBACK_ADJECTIVES = [
  'bright',
  'calm',
  'clear',
  'fresh',
  'kind',
  'lucky',
  'neat',
  'prime',
  'swift',
  'vivid',
];
const ORGANIZATION_SLUG_FALLBACK_NOUNS = [
  'atlas',
  'bridge',
  'field',
  'harbor',
  'lantern',
  'maple',
  'signal',
  'summit',
  'valley',
  'workshop',
];

function truncateSlug(slug: string, maxLength: number): string {
  return slug.slice(0, maxLength).replace(/-+$/g, '');
}

function pickRandomSlugWord(words: readonly string[]): string {
  return words[Math.floor(Math.random() * words.length)] ?? words[0] ?? 'team';
}

function randomFallbackSlug(): string {
  const adjective = pickRandomSlugWord(ORGANIZATION_SLUG_FALLBACK_ADJECTIVES);
  const noun = pickRandomSlugWord(ORGANIZATION_SLUG_FALLBACK_NOUNS);

  return `${adjective}-${noun}`;
}

function normalizeSlugSeparators(slug: string): string {
  return slug.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function removeReservedSlugSubstrings(slug: string): string {
  let cleanedSlug = slug;
  for (const reservedSubstring of ORGANIZATION_SLUG_RESERVED_SUBSTRINGS) {
    cleanedSlug = cleanedSlug.replaceAll(reservedSubstring, '');
  }
  return normalizeSlugSeparators(cleanedSlug);
}

export function organizationSlugContainsReservedSubstring(slug: string): boolean {
  const normalizedSlug = slug.toLowerCase();
  return ORGANIZATION_SLUG_RESERVED_SUBSTRINGS.some(reservedSubstring =>
    normalizedSlug.includes(reservedSubstring)
  );
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

  const slugWithoutReservedSubstrings = removeReservedSlugSubstrings(slug);
  const truncatedSlug = truncateSlug(slugWithoutReservedSubstrings, ORGANIZATION_SLUG_MAX_LENGTH);

  return truncatedSlug || randomFallbackSlug();
}

export function appendOrganizationSlugCollisionSuffix(slug: string, suffix: string): string {
  const baseMaxLength =
    ORGANIZATION_SLUG_MAX_LENGTH -
    ORGANIZATION_SLUG_SUFFIX_SEPARATOR_LENGTH -
    ORGANIZATION_SLUG_COLLISION_SUFFIX_LENGTH;
  const base = truncateSlug(slug, baseMaxLength);
  return `${base}-${suffix}`;
}
