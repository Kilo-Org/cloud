import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { orgnaization_modes, ORGANIZATION_MODES_ORG_SLUG_CONSTRAINT } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { OrganizationModeConfig } from '@/lib/organizations/organization-types';

export type OrganizationMode = typeof orgnaization_modes.$inferSelect;

const defaultConfig: OrganizationModeConfig = {
  groups: [],
  roleDefinition: 'default',
};

type OrganizationModeConfigWithLegacyDefaultModel = Partial<OrganizationModeConfig> & {
  defaultModel?: string;
};

function mergeToSatisfy(
  config: OrganizationModeConfigWithLegacyDefaultModel
): OrganizationModeConfig {
  const configWithoutLegacyDefaultModel = { ...config };
  delete configWithoutLegacyDefaultModel.defaultModel;

  return {
    ...defaultConfig,
    ...configWithoutLegacyDefaultModel,
  };
}

export async function createOrganizationMode(
  organizationId: string,
  createdBy: string,
  name: string,
  slug: string,
  config: Partial<OrganizationModeConfig> = {},
  txn?: DrizzleTransaction
): Promise<OrganizationMode | null> {
  const [mode] = await (txn ?? db)
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

export async function getAllOrganizationModes(
  organizationId: string,
  txn?: DrizzleTransaction
): Promise<OrganizationMode[]> {
  const modes = await (txn ?? db)
    .select()
    .from(orgnaization_modes)
    .where(eq(orgnaization_modes.organization_id, organizationId));

  return modes.map(mode => ({ ...mode, config: mergeToSatisfy(mode.config) }));
}

export async function getOrganizationModeById(
  organizationId: string,
  modeId: string,
  txn?: DrizzleTransaction,
  lockForUpdate = false
): Promise<OrganizationMode | null> {
  const query = (txn ?? db)
    .select()
    .from(orgnaization_modes)
    .where(
      and(eq(orgnaization_modes.id, modeId), eq(orgnaization_modes.organization_id, organizationId))
    );
  const [mode] = await (lockForUpdate ? query.for('update') : query);

  return mode ? { ...mode, config: mergeToSatisfy(mode.config) } : null;
}

export async function updateOrganizationMode(
  organizationId: string,
  modeId: string,
  updates: {
    name?: string;
    slug?: string;
    config?: Partial<OrganizationModeConfig>;
  },
  txn?: DrizzleTransaction
): Promise<OrganizationMode | null> {
  const updateData: Record<string, unknown> = {};

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }
  if (updates.slug !== undefined) {
    updateData.slug = updates.slug;
  }
  if (updates.config !== undefined) {
    const configPatch = Object.fromEntries(
      Object.entries(updates.config)
        .filter(([key]) => key !== 'defaultModel')
        .map(([key, value]) => [key, value === undefined ? null : value])
    );

    updateData.config = sql`jsonb_strip_nulls(((${JSON.stringify(defaultConfig)}::jsonb || (COALESCE(${orgnaization_modes.config}, '{}'::jsonb) - 'defaultModel')) || ${JSON.stringify(configPatch)}::jsonb))`;
  }

  try {
    const [mode] = await (txn ?? db)
      .update(orgnaization_modes)
      .set(updateData)
      .where(
        and(
          eq(orgnaization_modes.id, modeId),
          eq(orgnaization_modes.organization_id, organizationId)
        )
      )
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

export async function deleteOrganizationMode(
  modeId: string,
  txn?: DrizzleTransaction
): Promise<void> {
  await (txn ?? db).delete(orgnaization_modes).where(eq(orgnaization_modes.id, modeId));
}
