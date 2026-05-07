import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_agents,
  type AgentEnvironmentProfileAgent,
} from '@kilocode/db/schema';
import { AgentConfigSchema, type AgentConfig } from '@kilocode/db/schema-types';
import { and, eq, count } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { ProfileOwner, ProfileAgentResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';

export const MAX_PROFILE_AGENTS = 20;
export const MAX_AGENT_NAME_LENGTH = 100;
export const MAX_AGENT_SLUG_LENGTH = 50;

/**
 * Built-in kilo agent slugs reserved by cloud-agent-next. Profile-scoped
 * agents must not collide with these to keep the picker unambiguous.
 */
export const BUILTIN_AGENT_SLUGS = new Set([
  'code',
  'plan',
  'debug',
  'orchestrator',
  'ask',
  'build',
  'architect',
  'custom',
]);

// First char must be a letter — matches the kilocode extension's import
// validator (`/^[a-z][a-z0-9-]*$/`) so agents round-trip cleanly.
const AGENT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export const agentSlugSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_SLUG_LENGTH)
  .regex(
    AGENT_SLUG_PATTERN,
    'Agent slug must start with a lowercase letter and contain only lowercase letters, digits, and dashes'
  )
  .refine((slug: string) => !BUILTIN_AGENT_SLUGS.has(slug), {
    message: 'Slug conflicts with a built-in agent; choose a different slug',
  });

export const agentNameSchema = z.string().min(1).max(MAX_AGENT_NAME_LENGTH);

export const agentCreateInputSchema = z.object({
  slug: agentSlugSchema,
  name: agentNameSchema,
  config: AgentConfigSchema,
});

export const agentUpdateInputSchema = z.object({
  slug: agentSlugSchema.optional(),
  name: agentNameSchema.optional(),
  config: AgentConfigSchema.optional(),
});

export type AgentCreateInput = z.infer<typeof agentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateInputSchema>;

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

async function assertAgentLimit(db: WorkerDb, profileId: string): Promise<void> {
  const [row] = await db
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
  await assertAgentLimit(db, profileId);

  const [row] = await db
    .insert(agent_environment_profile_agents)
    .values({
      profile_id: profileId,
      slug: input.slug,
      name: input.name,
      config: input.config,
    })
    .returning({ id: agent_environment_profile_agents.id });

  return { id: row.id };
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
