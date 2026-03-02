import 'server-only';
import { db } from '@/lib/drizzle';
import { agent_environment_profile_vars } from '@kilocode/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { encryptWithPublicKey } from '@/lib/encryption';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';
import type { ProfileOwner, ProfileVarResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';

/**
 * Encrypt a value using the agent env vars public key.
 */
function encryptValue(value: string): string {
  if (!AGENT_ENV_VARS_PUBLIC_KEY) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Agent environment encryption key not configured',
    });
  }

  const publicKey = Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64');
  const envelope = encryptWithPublicKey(value, publicKey);
  return JSON.stringify(envelope);
}

/**
 * Set or update an environment variable for a profile.
 * If isSecret is true, the value is encrypted before storage.
 */
export async function setVar(
  profileId: string,
  key: string,
  value: string,
  isSecret: boolean,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  const storedValue = isSecret ? encryptValue(value) : value;

  await db
    .insert(agent_environment_profile_vars)
    .values({
      profile_id: profileId,
      key,
      value: storedValue,
      is_secret: isSecret,
    })
    .onConflictDoUpdate({
      target: [agent_environment_profile_vars.profile_id, agent_environment_profile_vars.key],
      set: {
        value: storedValue,
        is_secret: isSecret,
        updated_at: new Date().toISOString(),
      },
    });
}

/**
 * Delete an environment variable from a profile.
 */
export async function deleteVar(
  profileId: string,
  key: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  const result = await db
    .delete(agent_environment_profile_vars)
    .where(
      and(
        eq(agent_environment_profile_vars.profile_id, profileId),
        eq(agent_environment_profile_vars.key, key)
      )
    )
    .returning();

  if (result.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Environment variable not found',
    });
  }
}

/**
 * List all variables for a profile.
 * Secret values are masked as '***'.
 */
export async function listVars(
  profileId: string,
  owner: ProfileOwner
): Promise<ProfileVarResponse[]> {
  await verifyProfileOwnership(profileId, owner);

  const vars = await db
    .select({
      key: agent_environment_profile_vars.key,
      value: sql<string>`
        CASE
          WHEN ${agent_environment_profile_vars.is_secret} = true
          THEN '***'
          ELSE ${agent_environment_profile_vars.value}
        END
      `.as('value'),
      isSecret: agent_environment_profile_vars.is_secret,
      createdAt: agent_environment_profile_vars.created_at,
      updatedAt: agent_environment_profile_vars.updated_at,
    })
    .from(agent_environment_profile_vars)
    .where(eq(agent_environment_profile_vars.profile_id, profileId))
    .orderBy(agent_environment_profile_vars.key);

  return vars;
}

/**
 * Internal type for vars returned for session preparation.
 */
export type VarForSession = {
  key: string;
  value: string; // Plaintext for non-secrets, encrypted envelope JSON for secrets
  isSecret: boolean;
};

/**
 * Get all variables for a profile for session preparation.
 * Returns encrypted envelopes for secrets (not decrypted).
 * This is an internal function - no ownership check.
 */
export async function getVarsForSession(profileId: string): Promise<VarForSession[]> {
  const vars = await db
    .select({
      key: agent_environment_profile_vars.key,
      value: agent_environment_profile_vars.value,
      isSecret: agent_environment_profile_vars.is_secret,
    })
    .from(agent_environment_profile_vars)
    .where(eq(agent_environment_profile_vars.profile_id, profileId));

  return vars.map(v => ({
    key: v.key,
    value: v.value,
    isSecret: v.isSecret,
  }));
}

/**
 * Bulk set variables for a profile.
 * Useful for importing or updating multiple vars at once.
 */
export async function setVars(
  profileId: string,
  vars: Array<{ key: string; value: string; isSecret: boolean }>,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  if (vars.length === 0) {
    return;
  }

  const values = vars.map(v => ({
    profile_id: profileId,
    key: v.key,
    value: v.isSecret ? encryptValue(v.value) : v.value,
    is_secret: v.isSecret,
  }));

  await db.transaction(async tx => {
    for (const val of values) {
      await tx
        .insert(agent_environment_profile_vars)
        .values(val)
        .onConflictDoUpdate({
          target: [agent_environment_profile_vars.profile_id, agent_environment_profile_vars.key],
          set: {
            value: val.value,
            is_secret: val.is_secret,
            updated_at: new Date().toISOString(),
          },
        });
    }
  });
}
