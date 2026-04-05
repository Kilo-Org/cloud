import 'server-only';
import { db } from '@/lib/drizzle';
import { agent_environment_profile_commands } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { ProfileOwner, ProfileCommandResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';

/**
 * Set commands for a profile.
 * Replaces all existing commands with the new list.
 */
export async function setCommands(
  profileId: string,
  commands: string[],
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  await db.transaction(async tx => {
    // Delete existing commands
    await tx
      .delete(agent_environment_profile_commands)
      .where(eq(agent_environment_profile_commands.profile_id, profileId));

    // Insert new commands with sequence numbers
    if (commands.length > 0) {
      const values = commands.map((command, index) => ({
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
  profileId: string,
  owner: ProfileOwner
): Promise<ProfileCommandResponse[]> {
  await verifyProfileOwnership(profileId, owner);

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
export async function getCommandsForSession(profileId: string): Promise<string[]> {
  const commands = await db
    .select({
      command: agent_environment_profile_commands.command,
    })
    .from(agent_environment_profile_commands)
    .where(eq(agent_environment_profile_commands.profile_id, profileId))
    .orderBy(agent_environment_profile_commands.sequence);

  return commands.map(c => c.command);
}
