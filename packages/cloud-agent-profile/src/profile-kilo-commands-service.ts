import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_kilo_commands,
  type AgentEnvironmentProfileKiloCommand,
} from '@kilocode/db/schema';
import { and, eq, count, asc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { ProfileOwner, ProfileKiloCommandResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';

export const MAX_PROFILE_KILO_COMMANDS = 50;
export const MAX_KILO_COMMAND_NAME_LENGTH = 50;
export const MAX_KILO_COMMAND_TEMPLATE_LENGTH = 100_000;
export const MAX_KILO_COMMAND_DESCRIPTION_LENGTH = 2000;

export const BUILTIN_COMMAND_NAMES = new Set([
  'init',
  'review',
  'local-review',
  'local-review-uncommitted',
]);

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const kiloCommandNameSchema = z
  .string()
  .min(1)
  .max(MAX_KILO_COMMAND_NAME_LENGTH)
  .regex(
    COMMAND_NAME_PATTERN,
    'Command name must start with a lowercase letter and contain only lowercase letters, digits, and dashes'
  )
  .refine((name: string) => !BUILTIN_COMMAND_NAMES.has(name), {
    message: 'Name conflicts with a built-in command; choose a different name',
  });

export const kiloCommandCreateInputSchema = z.object({
  name: kiloCommandNameSchema,
  description: z.string().max(MAX_KILO_COMMAND_DESCRIPTION_LENGTH).optional(),
  template: z
    .string()
    .min(1)
    .max(
      MAX_KILO_COMMAND_TEMPLATE_LENGTH,
      `Command template exceeds ${MAX_KILO_COMMAND_TEMPLATE_LENGTH} bytes`
    ),
  agent: z.string().optional(),
  model: z.string().optional(),
  subtask: z.boolean().optional(),
});

export const kiloCommandUpdateInputSchema = z.object({
  name: kiloCommandNameSchema.optional(),
  description: z.string().max(MAX_KILO_COMMAND_DESCRIPTION_LENGTH).nullable().optional(),
  template: z
    .string()
    .min(1)
    .max(
      MAX_KILO_COMMAND_TEMPLATE_LENGTH,
      `Command template exceeds ${MAX_KILO_COMMAND_TEMPLATE_LENGTH} bytes`
    )
    .optional(),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  subtask: z.boolean().optional(),
});

export type KiloCommandCreateInput = z.infer<typeof kiloCommandCreateInputSchema>;
export type KiloCommandUpdateInput = z.infer<typeof kiloCommandUpdateInputSchema>;

function toResponse(row: AgentEnvironmentProfileKiloCommand): ProfileKiloCommandResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    template: row.template,
    agent: row.agent,
    model: row.model,
    subtask: row.subtask,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertCommandLimit(db: WorkerDb, profileId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(agent_environment_profile_kilo_commands)
    .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId));
  if (Number(row.n) >= MAX_PROFILE_KILO_COMMANDS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_KILO_COMMANDS} custom commands`,
    });
  }
}

async function fetchCommand(
  db: WorkerDb,
  commandId: string,
  profileId: string
): Promise<AgentEnvironmentProfileKiloCommand> {
  const [row] = await db
    .select()
    .from(agent_environment_profile_kilo_commands)
    .where(
      and(
        eq(agent_environment_profile_kilo_commands.id, commandId),
        eq(agent_environment_profile_kilo_commands.profile_id, profileId)
      )
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Command not found' });
  }
  return row;
}

export async function listKiloCommandsForProfile(
  db: WorkerDb,
  profileId: string
): Promise<ProfileKiloCommandResponse[]> {
  const rows = await db
    .select()
    .from(agent_environment_profile_kilo_commands)
    .where(eq(agent_environment_profile_kilo_commands.profile_id, profileId))
    .orderBy(
      asc(agent_environment_profile_kilo_commands.sort_order),
      asc(agent_environment_profile_kilo_commands.name)
    );
  return rows.map(toResponse);
}

export async function createKiloCommand(
  db: WorkerDb,
  profileId: string,
  input: KiloCommandCreateInput,
  owner: ProfileOwner
): Promise<{ id: string }> {
  await verifyProfileOwnership(db, profileId, owner);
  await assertCommandLimit(db, profileId);

  const [row] = await db
    .insert(agent_environment_profile_kilo_commands)
    .values({
      profile_id: profileId,
      name: input.name,
      description: input.description ?? null,
      template: input.template,
      agent: input.agent ?? null,
      model: input.model ?? null,
      subtask: input.subtask ?? false,
    })
    .returning({ id: agent_environment_profile_kilo_commands.id });

  return { id: row.id };
}

export async function updateKiloCommand(
  db: WorkerDb,
  profileId: string,
  commandId: string,
  input: KiloCommandUpdateInput,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchCommand(db, commandId, profileId);

  const updates: Partial<AgentEnvironmentProfileKiloCommand> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.template !== undefined) updates.template = input.template;
  if (input.agent !== undefined) updates.agent = input.agent;
  if (input.model !== undefined) updates.model = input.model;
  if (input.subtask !== undefined) updates.subtask = input.subtask;

  if (Object.keys(updates).length === 0) return;

  await db
    .update(agent_environment_profile_kilo_commands)
    .set(updates)
    .where(eq(agent_environment_profile_kilo_commands.id, commandId));
}

export async function deleteKiloCommand(
  db: WorkerDb,
  profileId: string,
  commandId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchCommand(db, commandId, profileId);
  await db
    .delete(agent_environment_profile_kilo_commands)
    .where(eq(agent_environment_profile_kilo_commands.id, commandId));
}

export async function setKiloCommandEnabled(
  db: WorkerDb,
  profileId: string,
  commandId: string,
  enabled: boolean,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchCommand(db, commandId, profileId);
  await db
    .update(agent_environment_profile_kilo_commands)
    .set({ enabled })
    .where(eq(agent_environment_profile_kilo_commands.id, commandId));
}

export async function reorderKiloCommands(
  db: WorkerDb,
  profileId: string,
  orderedIds: string[],
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);

  await db.transaction(async tx => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(agent_environment_profile_kilo_commands)
        .set({ sort_order: i })
        .where(
          and(
            eq(agent_environment_profile_kilo_commands.id, orderedIds[i]),
            eq(agent_environment_profile_kilo_commands.profile_id, profileId)
          )
        );
    }
  });
}

export type KiloCommandForSession = {
  name: string;
  description: string | null;
  template: string;
  agent: string | null;
  model: string | null;
  subtask: boolean;
};

export async function getKiloCommandsForSession(
  db: WorkerDb,
  profileId: string
): Promise<KiloCommandForSession[]> {
  const rows = await db
    .select({
      name: agent_environment_profile_kilo_commands.name,
      description: agent_environment_profile_kilo_commands.description,
      template: agent_environment_profile_kilo_commands.template,
      agent: agent_environment_profile_kilo_commands.agent,
      model: agent_environment_profile_kilo_commands.model,
      subtask: agent_environment_profile_kilo_commands.subtask,
    })
    .from(agent_environment_profile_kilo_commands)
    .where(
      and(
        eq(agent_environment_profile_kilo_commands.profile_id, profileId),
        eq(agent_environment_profile_kilo_commands.enabled, true)
      )
    )
    .orderBy(
      asc(agent_environment_profile_kilo_commands.sort_order),
      asc(agent_environment_profile_kilo_commands.name)
    );
  return rows;
}
