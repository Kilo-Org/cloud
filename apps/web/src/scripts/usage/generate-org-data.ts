/**
 * Generate mock microdollar_usage data for an organization and three direct
 * sub-organizations.
 *
 * Usage:
 *   pnpm --filter web script:run usage generate-org-data <orgId>
 *   pnpm --filter web script:run usage generate-org-data <orgId> --reset
 *
 * Flags:
 *   --reset   Delete existing microdollar_usage + metadata attributed to
 *             this organization before inserting new records.
 *
 * The sub-organizations and their mock users are deterministic and safe to
 * generate repeatedly. Usage records are intentionally additive unless
 * `--reset` is supplied. Records span the last 13 months with realistic
 * density (heavy recent activity, sparser in older months) and variety across
 * models, providers, features, modes, projects, and users.
 *
 * The Usage Analytics page reads from Snowflake; no further local steps are
 * needed after inserting records with this script.
 */
import { strict as assert } from 'node:assert';
import { db } from '@/lib/drizzle';
import type { Organization } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { cliConfirm } from '@/scripts/lib/cli-confirm';
import { ensureOrgHasAtLeast } from './lib/mock-users';
import {
  deleteOrgUsageFor,
  ensureLookupsSeeded,
  generateAndInsertMockUsage,
} from './lib/generate-mock-usage';
import { v5 as uuidv5 } from 'uuid';

const TARGET_MEMBER_COUNT = 15;
const SUB_ORGANIZATION_MEMBER_COUNT = 8;

type SubOrganizationDefinition = {
  key: string;
  name: string;
  plan: Organization['plan'];
  requireSeats: boolean;
  settings: Organization['settings'];
};

const SUB_ORGANIZATIONS = [
  {
    key: 'engineering',
    name: 'Engineering',
    plan: 'enterprise',
    requireSeats: true,
    settings: {
      minimum_balance: 25,
      enable_usage_limits: true,
      code_indexing_enabled: true,
      projects_ui_enabled: true,
      data_collection: 'deny',
      provider_allow_list: ['openai', 'anthropic'],
      model_deny_list: ['openai/gpt-3.5-turbo'],
    },
  },
  {
    key: 'research',
    name: 'Research',
    plan: 'teams',
    requireSeats: false,
    settings: {
      minimum_balance: 10,
      enable_usage_limits: true,
      code_indexing_enabled: true,
      projects_ui_enabled: false,
      data_collection: 'allow',
      // Intentionally configured on Teams so the Models tab can show them as inert.
      provider_allow_list: ['google'],
      model_deny_list: ['anthropic/claude-3-haiku'],
    },
  },
  {
    key: 'customer-success',
    name: 'Customer Success',
    plan: 'enterprise',
    requireSeats: true,
    settings: {
      minimum_balance: 15,
      enable_usage_limits: false,
      code_indexing_enabled: false,
      projects_ui_enabled: true,
      data_collection: 'allow',
    },
  },
] satisfies SubOrganizationDefinition[];

type Flags = {
  reset: boolean;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { reset: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--reset') {
      flags.reset = true;
    } else {
      console.warn(`Unknown flag: ${arg}`);
    }
  }
  return flags;
}

function mockSubOrganizationId(parentOrganizationId: string, key: string): string {
  return uuidv5(`usage-generate-org-data:${key}`, parentOrganizationId);
}

export async function ensureMockSubOrganizations(parent: typeof organizations.$inferSelect) {
  const definitions = SUB_ORGANIZATIONS.map(definition => ({
    ...definition,
    id: mockSubOrganizationId(parent.id, definition.key),
  }));

  await db
    .insert(organizations)
    .values(
      definitions.map(definition => ({
        id: definition.id,
        name: `${parent.name} - ${definition.name}`,
        parent_organization_id: parent.id,
        plan: definition.plan,
        require_seats: definition.requireSeats,
        seat_count: 12,
        total_microdollars_acquired: 100_000_000,
        microdollars_balance: 100_000_000,
        settings: definition.settings,
        auto_top_up_enabled: definition.key === 'customer-success',
        free_trial_end_at: null,
      }))
    )
    .onConflictDoNothing({ target: organizations.id });

  const children = await db.query.organizations.findMany({
    where: and(
      eq(organizations.parent_organization_id, parent.id),
      isNull(organizations.deleted_at)
    ),
  });
  const childrenById = new Map(children.map(child => [child.id, child]));

  return definitions.map(definition => {
    const child = childrenById.get(definition.id);
    if (!child) {
      throw new Error(
        `Deterministic sub-organization ID ${definition.id} already exists outside parent ${parent.id}`
      );
    }
    return child;
  });
}

async function ensureRepresentativeRoles(organizationId: string, memberIds: string[]) {
  const [ownerId, billingManagerId] = memberIds;
  if (ownerId) {
    await db
      .update(organization_memberships)
      .set({ role: 'owner' })
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, ownerId)
        )
      );
  }
  if (billingManagerId) {
    await db
      .update(organization_memberships)
      .set({ role: 'billing_manager' })
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, billingManagerId)
        )
      );
  }
}

export async function ensureMockOrganizationMembers(
  organizationId: string,
  targetCount: number,
  assignRepresentativeRoles: boolean
) {
  const { members, created } = await ensureOrgHasAtLeast(organizationId, targetCount);
  const sortedMembers = members.toSorted((left, right) => left.email.localeCompare(right.email));
  if (assignRepresentativeRoles) {
    await ensureRepresentativeRoles(
      organizationId,
      sortedMembers.map(member => member.userId)
    );
  }
  return { members: sortedMembers, created };
}

async function topUpForGeneratedUsage(
  organizationId: string,
  totalCostMicrodollars: number
): Promise<void> {
  const current = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!current) throw new Error(`Organization ${organizationId} disappeared during generation`);

  const currentBalance =
    Number(current.total_microdollars_acquired) - Number(current.microdollars_used);
  const requiredBalance = totalCostMicrodollars + 1_000_000;
  if (currentBalance >= requiredBalance) {
    console.log(
      `  Balance already covers generated cost (${currentBalance} >= ${requiredBalance}).`
    );
    return;
  }

  const delta = requiredBalance - currentBalance;
  console.log(
    `  Topping up balance by ${delta} microdollars ($${(delta / 1_000_000).toFixed(2)}).`
  );
  await db
    .update(organizations)
    .set({
      total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${delta}`,
      microdollars_balance: sql`${organizations.microdollars_balance} + ${delta}`,
    })
    .where(eq(organizations.id, organizationId));
}

export async function run(...args: string[]): Promise<void> {
  const [orgId, ...rest] = args;
  assert(orgId, 'Organization ID is required as the first argument');
  const flags = parseFlags(rest);

  const org = await db.query.organizations.findFirst({
    where: and(eq(organizations.id, orgId), isNull(organizations.deleted_at)),
  });
  if (!org) {
    throw new Error(`Organization ${orgId} not found (or soft-deleted)`);
  }
  if (org.parent_organization_id) {
    throw new Error('generate-org-data must target a parent organization, not a sub-organization');
  }

  const subOrganizations = await ensureMockSubOrganizations(org);
  const targets = [org, ...subOrganizations];
  console.log(`Generating mock usage for parent organization: ${org.name} (${orgId})`);
  console.log('Sub-organizations:');
  subOrganizations.forEach(child => console.log(`  - ${child.name} (${child.id})`));

  if (flags.reset) {
    await cliConfirm(
      `--reset will DELETE all microdollar_usage rows for the parent and generated sub-organizations. Continue?`
    );
    for (const target of targets) {
      const { deleted } = await deleteOrgUsageFor(target.id);
      console.log(`Deleted ${deleted} existing rows for ${target.name}.`);
    }
  }

  const lookups = await ensureLookupsSeeded();
  let totalRecordCount = 0;
  for (const target of targets) {
    console.log('');
    console.log(`Generating data for ${target.name} (${target.id})`);
    const targetMemberCount =
      target.id === org.id ? TARGET_MEMBER_COUNT : SUB_ORGANIZATION_MEMBER_COUNT;
    const { members: sortedMembers, created } = await ensureMockOrganizationMembers(
      target.id,
      targetMemberCount,
      target.id !== org.id
    );
    if (created.length > 0) {
      console.log(`  Created ${created.length} mock users (now ${sortedMembers.length} members).`);
    } else {
      console.log(`  Reused ${sortedMembers.length} members (target ${targetMemberCount}).`);
    }

    const stats = await generateAndInsertMockUsage(
      {
        kiloUserIds: sortedMembers.map(member => member.userId),
        organizationId: target.id,
      },
      lookups
    );
    totalRecordCount += stats.recordCount;
    await topUpForGeneratedUsage(target.id, stats.totalCostMicrodollars);
    console.log(`  Inserted ${stats.recordCount} usage records.`);
  }

  console.log('');
  console.log(
    `Done. Inserted ${totalRecordCount} usage records across ${targets.length} organizations.`
  );
  console.log('');
  console.log(
    'Usage Analytics reads from Snowflake; point the sandbox env at DBT_BACKEND_SANDBOX to see data.'
  );
}
