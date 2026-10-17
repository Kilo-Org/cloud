import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_agents,
  agent_environment_profiles,
  type AgentEnvironmentProfileAgent,
} from '@kilocode/db/schema';
import { AgentConfigSchema, type AgentConfig } from '@kilocode/db/schema-types';
import { and, eq, count } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner, ProfileAgentResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';
import {
  MAX_PROFILE_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_SLUG_LENGTH,
  BUILTIN_AGENT_SLUGS,
  agentSlugSchema,
  agentNameSchema,
  agentCreateInputSchema,
  agentUpdateInputSchema,
  type AgentCreateInput,
  type AgentUpdateInput,
} from './contracts/agents';

export {
  MAX_PROFILE_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_SLUG_LENGTH,
  BUILTIN_AGENT_SLUGS,
  agentSlugSchema,
  agentNameSchema,
  agentCreateInputSchema,
  agentUpdateInputSchema,
};
export type { AgentCreateInput, AgentUpdateInput };

type AgentWriteTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

function toResponse(row: AgentEnvironmentProfileAgent): ProfileAgentResponse {
  // Parse rather than cast so a malformed stored row surfaces as a clear
  // validation error instead of crashing downstream consumers.
  const config = AgentConfigSchema.parse(row.config ?? {});
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertAgentLimit(tx: AgentWriteTransaction, profileId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(agent_environment_profile_agents)
    .where(eq(agent_environment_profile_agents.profile_id, profileId));
  if (Number(row.n) >= MAX_PROFILE_AGENTS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_AGENTS} agents`,
    });
  }
}

async function fetchAgent(
  db: WorkerDb,
  agentId: string,
  profileId: string
): Promise<AgentEnvironmentProfileAgent> {
  const [row] = await db
    .select()
    .from(agent_environment_profile_agents)
    .where(
      and(
        eq(agent_environment_profile_agents.id, agentId),
        eq(agent_environment_profile_agents.profile_id, profileId)
      )
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
  }
  return row;
}

/**
 * List all agents for a profile in slug order.
 * Internal: no ownership check; used by `profile-service.getProfile`.
 */
export async function listAgentsForProfile(
  db: WorkerDb,
  profileId: string
): Promise<ProfileAgentResponse[]> {
  const rows = await db
    .select()
    .from(agent_environment_profile_agents)
    .where(eq(agent_environment_profile_agents.profile_id, profileId))
    .orderBy(agent_environment_profile_agents.slug);
  return rows.map(toResponse);
}

export async function createAgent(
  db: WorkerDb,
  profileId: string,
  input: AgentCreateInput,
  owner: ProfileOwner
): Promise<{ id: string }> {
  await verifyProfileOwnership(db, profileId, owner);

  return await db.transaction(async tx => {
    // Lock the owning profile row so the cap count and the insert are one
    // serialized unit, keeping concurrent creates within the per-profile cap.
    await tx
      .select({ id: agent_environment_profiles.id })
      .from(agent_environment_profiles)
      .where(eq(agent_environment_profiles.id, profileId))
      .for('update');

    await assertAgentLimit(tx, profileId);

    const [row] = await tx
      .insert(agent_environment_profile_agents)
      .values({
        profile_id: profileId,
        slug: input.slug,
        name: input.name,
        config: input.config,
      })
      .returning({ id: agent_environment_profile_agents.id });

    return { id: row.id };
  });
}

export async function updateAgent(
  db: WorkerDb,
  profileId: string,
  agentId: string,
  input: AgentUpdateInput,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchAgent(db, agentId, profileId);

  const updates: Partial<AgentEnvironmentProfileAgent> = {};
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) updates.config = input.config;

  if (Object.keys(updates).length === 0) return;

  await db
    .update(agent_environment_profile_agents)
    .set(updates)
    .where(eq(agent_environment_profile_agents.id, agentId));
}

export async function deleteAgent(
  db: WorkerDb,
  profileId: string,
  agentId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchAgent(db, agentId, profileId);
  await db
    .delete(agent_environment_profile_agents)
    .where(eq(agent_environment_profile_agents.id, agentId));
}

/**
 * Shape used for session materialization.
 * Internal: no ownership check.
 */
export type AgentForSession = {
  slug: string;
  name: string;
  config: AgentConfig;
};

export async function getAgentsForSession(
  db: WorkerDb,
  profileId: string
): Promise<AgentForSession[]> {
  const rows = await db
    .select({
      slug: agent_environment_profile_agents.slug,
      name: agent_environment_profile_agents.name,
      config: agent_environment_profile_agents.config,
    })
    .from(agent_environment_profile_agents)
    .where(eq(agent_environment_profile_agents.profile_id, profileId))
    .orderBy(agent_environment_profile_agents.slug);
  return rows.map(row => ({
    slug: row.slug,
    name: row.name,
    config: AgentConfigSchema.parse(row.config ?? {}),
  }));
}
