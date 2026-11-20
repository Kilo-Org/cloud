import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_commands,
  agent_environment_profile_vars,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner } from './types';
import { assertValidEnvironmentKey } from './environment-contracts';
import {
  MAX_PROFILE_VARS,
  profileVarColumns,
  type ProfileNetworkSecretPolicy,
} from './profile-vars-service';
import { assertNetworkSecretKeySpace } from './network-secret-storage';
import { assertWritableCommands } from './profile-commands-service';
import { applyDefaultProfile, insertProfileRow } from './profile-service';

/** One variable offered at creation, before any at-rest transformation. */
export type ProfileCreateVar = {
  key: string;
  value: string;
  isSecret: boolean;
  networkSecret?: ProfileNetworkSecretPolicy;
};

export type ProfileCreateInput = {
  name: string;
  description?: string;
  vars?: readonly ProfileCreateVar[];
  commands?: readonly string[];
  setAsDefault?: boolean;
};

/**
 * The variable rules a create must satisfy before it writes anything. A create
 * starts from an empty profile, so unlike `setVar` an update path cannot exempt
 * a key: every key here is new.
 */
function assertCreatableVars(vars: readonly ProfileCreateVar[]): void {
  if (vars.length > MAX_PROFILE_VARS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_VARS} variables`,
    });
  }

  const seen = new Set<string>();
  for (const variable of vars) {
    assertValidEnvironmentKey(variable.key);
    if (seen.has(variable.key)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Duplicate environment variable key',
      });
    }
    seen.add(variable.key);
  }

  // A network secret and an env variable cannot share a key, in the create or
  // in the profile's session layer. The setVar path checks the same rule.
  assertNetworkSecretKeySpace(
    vars.filter(variable => !variable.networkSecret).map(variable => variable.key),
    vars.filter(variable => variable.networkSecret).map(variable => variable.key)
  );
}

/**
 * Create a profile together with the content a caller would otherwise write in
 * follow-up calls: its variables, its setup commands, and the default flag.
 *
 * Everything runs in one transaction, so a payload the profile's rules reject
 * — an invalid or duplicate key, an over-cap list, an encryption failure —
 * leaves no profile behind, secret rows included. The profile row insert keeps
 * the same owner creation lock and cap as a bare create.
 */
export async function createProfileWithContent(
  db: WorkerDb,
  publicKeyBase64: string,
  owner: ProfileOwner,
  createdByUserId: string,
  input: ProfileCreateInput
): Promise<{ id: string }> {
  const vars = input.vars ?? [];
  const commands = input.commands ?? [];
  assertCreatableVars(vars);
  assertWritableCommands(commands);

  return await db.transaction(async tx => {
    const profileId = await insertProfileRow(
      tx,
      owner,
      createdByUserId,
      input.name,
      input.description
    );

    if (vars.length > 0) {
      await tx.insert(agent_environment_profile_vars).values(
        vars.map(variable => ({
          profile_id: profileId,
          ...profileVarColumns(publicKeyBase64, variable),
        }))
      );
    }

    if (commands.length > 0) {
      await tx.insert(agent_environment_profile_commands).values(
        commands.map((command, index) => ({
          profile_id: profileId,
          sequence: index,
          command,
        }))
      );
    }

    if (input.setAsDefault === true) {
      await applyDefaultProfile(tx, profileId, owner);
    }

    return { id: profileId };
  });
}
