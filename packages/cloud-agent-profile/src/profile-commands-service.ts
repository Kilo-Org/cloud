import type { WorkerDb } from '@kilocode/db';
import { agent_environment_profile_commands } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner, ProfileCommandResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';

/** A profile holds at most this many setup commands. */
export const MAX_PROFILE_COMMANDS = 20;

/** Each setup command is at most this many characters. */
export const MAX_PROFILE_COMMAND_LENGTH = 500;

/**
 * The commands a write stores: whitespace-only rows never reach the table, and
 * the list and length bounds are checked on what is left, so a stored list and a
 * re-sent list always pass the same rule.
 *
 * The create and the replace path both store this exact list, so neither can
 * store a list the other refuses.
 */
export function writableCommands(commands: readonly string[]): string[] {
  const kept = commands.filter(command => command.trim().length > 0);

  if (kept.length > MAX_PROFILE_COMMANDS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_COMMANDS} setup commands`,
    });
  }

  for (const command of kept) {
    if (command.length > MAX_PROFILE_COMMAND_LENGTH) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Setup commands are limited to ${MAX_PROFILE_COMMAND_LENGTH} characters`,
      });
    }
  }

  return kept;
}

/**
 * Set commands for a profile.
 * Replaces all existing commands with the new list.
 */
export async function setCommands(
  db: WorkerDb,
  profileId: string,
  commands: string[],
  owner: ProfileOwner
): Promise<void> {
  // The ownership check runs first, so a caller without this profile learns
  // that before any verdict on the list. Before the delete: an over-cap list
  // must never clear the stored commands and then fail, leaving the profile
  // with none.
  await verifyProfileOwnership(db, profileId, owner);
  const stored = writableCommands(commands);

  await db.transaction(async tx => {
    await tx
      .delete(agent_environment_profile_commands)
      .where(eq(agent_environment_profile_commands.profile_id, profileId));

    if (stored.length > 0) {
      const values = stored.map((command, index) => ({
        profile_id: profileId,
        sequence: index,
        command,
      }));

      await tx.insert(agent_environment_profile_commands).values(values);
    }
  });
}

/**
 * List commands for a profile in order.
 */
export async function listCommands(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<ProfileCommandResponse[]> {
  await verifyProfileOwnership(db, profileId, owner);

  const commands = await db
    .select({
      sequence: agent_environment_profile_commands.sequence,
      command: agent_environment_profile_commands.command,
    })
    .from(agent_environment_profile_commands)
    .where(eq(agent_environment_profile_commands.profile_id, profileId))
    .orderBy(agent_environment_profile_commands.sequence);

  return commands;
}

/**
 * Get commands for a profile for session preparation.
 * Returns just the command strings in order.
 * This is an internal function - no ownership check.
 */
export async function getCommandsForSession(db: WorkerDb, profileId: string): Promise<string[]> {
  const commands = await db
    .select({
      command: agent_environment_profile_commands.command,
    })
    .from(agent_environment_profile_commands)
    .where(eq(agent_environment_profile_commands.profile_id, profileId))
    .orderBy(agent_environment_profile_commands.sequence);

  return commands.map(c => c.command);
}
