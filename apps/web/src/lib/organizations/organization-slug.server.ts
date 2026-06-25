import 'server-only';

import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import { sql, type DrizzleTransaction } from '@/lib/drizzle';
import {
  appendOrganizationSlugCollisionSuffix,
  normalizeOrganizationSlug,
  ORGANIZATION_SLUG_COLLISION_SUFFIX_LENGTH,
} from '@/lib/organizations/organization-slug';

const ORGANIZATION_SLUG_ALLOCATION_LOCK_KEY_1 = 20260625;
const ORGANIZATION_SLUG_ALLOCATION_LOCK_KEY_2 = 1;
const MAX_ORGANIZATION_SLUG_ALLOCATION_ATTEMPTS = 32;
const DELETED_ORGANIZATION_SLUG_PREFIX = 'deleted-';
const DELETED_ORGANIZATION_SLUG_RANDOM_BYTES = 12;
export const MAX_DELETED_ORGANIZATION_SLUG_ATTEMPTS = 5;

async function organizationSlugExists(slug: string, tx: DrizzleTransaction): Promise<boolean> {
  const [existingOrganization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);

  return existingOrganization !== undefined;
}

function generateOrganizationSlugCollisionSuffix(): string {
  return randomBytes(2).toString('hex').slice(0, ORGANIZATION_SLUG_COLLISION_SUFFIX_LENGTH);
}

function generateDeletedOrganizationSlug(): string {
  return `${DELETED_ORGANIZATION_SLUG_PREFIX}${randomBytes(DELETED_ORGANIZATION_SLUG_RANDOM_BYTES).toString('hex')}`;
}

export async function allocateOrganizationSlug(
  name: string,
  tx: DrizzleTransaction
): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ORGANIZATION_SLUG_ALLOCATION_LOCK_KEY_1}, ${ORGANIZATION_SLUG_ALLOCATION_LOCK_KEY_2})`
  );

  const baseSlug = normalizeOrganizationSlug(name);

  for (let attempt = 0; attempt < MAX_ORGANIZATION_SLUG_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidateSlug =
      attempt === 0
        ? baseSlug
        : appendOrganizationSlugCollisionSuffix(
            baseSlug,
            generateOrganizationSlugCollisionSuffix()
          );

    if (!(await organizationSlugExists(candidateSlug, tx))) {
      return candidateSlug;
    }
  }

  throw new Error(`Failed to allocate organization slug for "${name}"`);
}

export async function allocateDeletedOrganizationSlug(tx: DrizzleTransaction): Promise<string> {
  for (let attempt = 0; attempt < MAX_DELETED_ORGANIZATION_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = generateDeletedOrganizationSlug();

    if (!(await organizationSlugExists(candidateSlug, tx))) {
      return candidateSlug;
    }
  }

  throw new Error('Failed to allocate deleted organization slug');
}
