import { db } from '@/lib/drizzle';
import { orgnaization_modes, ORGANIZATION_MODES_ORG_SLUG_CONSTRAINT } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { OrganizationModeConfig } from '@/lib/organizations/organization-types';

export type OrganizationMode = typeof orgnaization_modes.$inferSelect;

const defaultConfig: OrganizationModeConfig = {
  groups: [],
  roleDefinition: 'default',
};

function mergeToSatisfy(config: Partial<OrganizationModeConfig>): OrganizationModeConfig {
  return {
    ...defaultConfig,
    ...config,
  };
}

export async function createOrganizationMode(
  organizationId: string,
  createdBy: string,
  name: string,
  slug: string,
  config: Partial<OrganizationModeConfig> = {}
): Promise<OrganizationMode | null> {
  const [mode] = await db
    .insert(orgnaization_modes)
    .values({
      organization_id: organizationId,
      created_by: createdBy,
      name,
      slug,
      config: mergeToSatisfy(config),
    })
    .onConflictDoNothing()
    .returning();

  return mode || null;
}

export async function getAllOrganizationModes(organizationId: string): Promise<OrganizationMode[]> {
  const modes = await db
    .select()
    .from(orgnaization_modes)
    .where(eq(orgnaization_modes.organization_id, organizationId));

  return modes.map(mode => ({ ...mode, config: mergeToSatisfy(mode.config) }));
}

export async function getOrganizationModeById(
  organizationId: string,
  modeId: string
): Promise<OrganizationMode | null> {
  const [mode] = await db
    .select()
    .from(orgnaization_modes)
    .where(
      and(eq(orgnaization_modes.id, modeId), eq(orgnaization_modes.organization_id, organizationId))
    );

  return mode ? { ...mode, config: mergeToSatisfy(mode.config) } : null;
}

export async function updateOrganizationMode(
  modeId: string,
  updates: {
    name?: string;
    slug?: string;
    config?: Partial<OrganizationModeConfig>;
  }
): Promise<OrganizationMode | null> {
  const updateData: Record<string, unknown> = {};

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }
  if (updates.slug !== undefined) {
    updateData.slug = updates.slug;
  }
  if (updates.config !== undefined) {
    updateData.config = mergeToSatisfy(updates.config);
  }

  try {
    const [mode] = await db
      .update(orgnaization_modes)
      .set(updateData)
      .where(eq(orgnaization_modes.id, modeId))
      .returning();

    return mode ? { ...mode, config: mergeToSatisfy(mode.config) } : null;
  } catch (error) {
    // Check if it's a unique constraint violation
    if (error instanceof Error && error.message.includes(ORGANIZATION_MODES_ORG_SLUG_CONSTRAINT)) {
      return null;
    }
    throw error;
  }
}

export async function deleteOrganizationMode(modeId: string): Promise<void> {
  await db.delete(orgnaization_modes).where(eq(orgnaization_modes.id, modeId));
}
