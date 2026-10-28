import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_instructions,
  agent_environment_profiles,
  type AgentEnvironmentProfileInstruction,
} from '@kilocode/db/schema';
import { and, eq, count, asc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { ProfileOwner, ProfileInstructionResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';
import {
  MAX_IMPORT_INSTRUCTIONS,
  instructionImportSchema,
  instructionNameSchema,
} from './import/instructions';

/**
 * Instruction files share the import contract's limits and name rules: a
 * single owner (`./import/instructions`) decides the slug shape, the reserved
 * `cloud-agent` name, the per-profile cap, and the content cap, so storage and
 * import cannot drift.
 */
export const MAX_PROFILE_INSTRUCTIONS = MAX_IMPORT_INSTRUCTIONS;
export const instructionCreateInputSchema = instructionImportSchema;
export const instructionUpdateInputSchema = z.object({
  name: instructionNameSchema.optional(),
  content: instructionImportSchema.shape.content.optional(),
});
export type InstructionCreateInput = z.infer<typeof instructionCreateInputSchema>;
export type InstructionUpdateInput = z.infer<typeof instructionUpdateInputSchema>;

type InstructionWriteTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

function toResponse(row: AgentEnvironmentProfileInstruction): ProfileInstructionResponse {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertInstructionLimit(
  tx: InstructionWriteTransaction,
  profileId: string
): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(agent_environment_profile_instructions)
    .where(eq(agent_environment_profile_instructions.profile_id, profileId));
  if (Number(row.n) >= MAX_PROFILE_INSTRUCTIONS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_INSTRUCTIONS} instruction files`,
    });
  }
}

async function fetchInstruction(
  db: WorkerDb,
  instructionId: string,
  profileId: string
): Promise<AgentEnvironmentProfileInstruction> {
  const [row] = await db
    .select()
    .from(agent_environment_profile_instructions)
    .where(
      and(
        eq(agent_environment_profile_instructions.id, instructionId),
        eq(agent_environment_profile_instructions.profile_id, profileId)
      )
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Instruction not found' });
  }
  return row;
}

export async function listInstructionsForProfile(
  db: WorkerDb,
  profileId: string
): Promise<ProfileInstructionResponse[]> {
  const rows = await db
    .select()
    .from(agent_environment_profile_instructions)
    .where(eq(agent_environment_profile_instructions.profile_id, profileId))
    .orderBy(asc(agent_environment_profile_instructions.name));
  return rows.map(toResponse);
}

export async function createInstruction(
  db: WorkerDb,
  profileId: string,
  input: InstructionCreateInput,
  owner: ProfileOwner
): Promise<{ id: string }> {
  const parsed = instructionCreateInputSchema.parse(input);
  await verifyProfileOwnership(db, profileId, owner);

  return await db.transaction(async tx => {
    // Lock the owning profile row so the cap count and the insert are one
    // serialized unit. Without the lock two concurrent creates each observe
    // headroom and both insert, exceeding the per-profile cap.
    await tx
      .select({ id: agent_environment_profiles.id })
      .from(agent_environment_profiles)
      .where(eq(agent_environment_profiles.id, profileId))
      .for('update');

    await assertInstructionLimit(tx, profileId);

    const [row] = await tx
      .insert(agent_environment_profile_instructions)
      .values({
        profile_id: profileId,
        name: parsed.name,
        content: parsed.content,
      })
      .returning({ id: agent_environment_profile_instructions.id });

    return { id: row.id };
  });
}

export async function updateInstruction(
  db: WorkerDb,
  profileId: string,
  instructionId: string,
  input: InstructionUpdateInput,
  owner: ProfileOwner
): Promise<void> {
  const parsed = instructionUpdateInputSchema.parse(input);
  await verifyProfileOwnership(db, profileId, owner);
  await fetchInstruction(db, instructionId, profileId);

  const updates: Partial<AgentEnvironmentProfileInstruction> = {};
  if (parsed.name !== undefined) updates.name = parsed.name;
  if (parsed.content !== undefined) updates.content = parsed.content;

  if (Object.keys(updates).length === 0) return;

  await db
    .update(agent_environment_profile_instructions)
    .set(updates)
    .where(eq(agent_environment_profile_instructions.id, instructionId));
}

export async function deleteInstruction(
  db: WorkerDb,
  profileId: string,
  instructionId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchInstruction(db, instructionId, profileId);
  await db
    .delete(agent_environment_profile_instructions)
    .where(eq(agent_environment_profile_instructions.id, instructionId));
}

export async function setInstructionEnabled(
  db: WorkerDb,
  profileId: string,
  instructionId: string,
  enabled: boolean,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchInstruction(db, instructionId, profileId);
  await db
    .update(agent_environment_profile_instructions)
    .set({ enabled })
    .where(eq(agent_environment_profile_instructions.id, instructionId));
}

export type InstructionForSession = {
  name: string;
  content: string;
};

export async function getInstructionsForSession(
  db: WorkerDb,
  profileId: string
): Promise<InstructionForSession[]> {
  const rows = await db
    .select({
      name: agent_environment_profile_instructions.name,
      content: agent_environment_profile_instructions.content,
    })
    .from(agent_environment_profile_instructions)
    .where(
      and(
        eq(agent_environment_profile_instructions.profile_id, profileId),
        eq(agent_environment_profile_instructions.enabled, true)
      )
    )
    .orderBy(asc(agent_environment_profile_instructions.name));
  return rows;
}
