import * as z from 'zod';
import {
  getProfileIdByName,
  getEffectiveDefaultProfileId,
  getDefaultProfile,
} from './profile-service';
import { getVarsForSession } from './profile-vars-service';
import { getCommandsForSession } from './profile-commands-service';
import type { EncryptedEnvelope } from '@/lib/encryption';
import type { ProfileOwner } from './types';

// Schema to validate encrypted envelope structure from database
const encryptedEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export class ProfileNotFoundError extends Error {
  constructor(public profileName: string) {
    super(`Profile '${profileName}' not found`);
    this.name = 'ProfileNotFoundError';
  }
}

export type MergeProfileConfigurationArgs = {
  profileName?: string;
  owner: ProfileOwner;
  /** When in org context, enables searching personal profiles and using effective default. */
  userId?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

export type MergeProfileConfigurationResult = {
  envVars?: Record<string, string>;
  setupCommands?: string[];
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
};

export async function mergeProfileConfiguration({
  profileName,
  owner,
  userId,
  envVars = {},
  setupCommands = [],
}: MergeProfileConfigurationArgs): Promise<MergeProfileConfigurationResult> {
  let mergedEnvVars = { ...envVars };
  let mergedSetupCommands = [...setupCommands];
  let encryptedSecrets: Record<string, EncryptedEnvelope> | undefined;

  // Resolve profile ID based on context
  let profileId: string | null = null;

  if (profileName) {
    // When profileName is provided, search for it
    // In org context with userId, try org profiles first, then personal
    if (owner.type === 'organization' && userId) {
      profileId = await getProfileIdByName(profileName, owner);
      if (!profileId) {
        // Fall back to user's personal profile
        profileId = await getProfileIdByName(profileName, { type: 'user', id: userId });
      }
    } else {
      profileId = await getProfileIdByName(profileName, owner);
    }

    if (!profileId) {
      throw new ProfileNotFoundError(profileName);
    }
  } else {
    // No profileName provided - use effective default
    if (owner.type === 'organization' && userId) {
      // In org context, use effective default (org default > personal default)
      profileId = await getEffectiveDefaultProfileId(userId, owner.id);
    } else {
      // In personal context, use user's default
      const defaultProfile = await getDefaultProfile(owner);
      profileId = defaultProfile?.id ?? null;
    }
  }

  if (!profileId) {
    return {
      envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
      setupCommands: mergedSetupCommands.length > 0 ? mergedSetupCommands : undefined,
      encryptedSecrets,
    };
  }

  const [profileVars, profileCommands] = await Promise.all([
    getVarsForSession(profileId),
    getCommandsForSession(profileId),
  ]);

  const profileEnvVars: Record<string, string> = {};
  const profileSecrets: Record<string, EncryptedEnvelope> = {};

  for (const variable of profileVars) {
    if (variable.isSecret) {
      // Secrets are stored as JSON strings in the database, parse and validate them
      const parsed = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
      profileSecrets[variable.key] = parsed;
    } else {
      profileEnvVars[variable.key] = variable.value;
    }
  }

  mergedEnvVars = { ...profileEnvVars, ...mergedEnvVars };
  mergedSetupCommands = [...profileCommands, ...mergedSetupCommands];

  if (Object.keys(profileSecrets).length > 0) {
    encryptedSecrets = profileSecrets;
  }

  return {
    envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
    setupCommands: mergedSetupCommands.length > 0 ? mergedSetupCommands : undefined,
    encryptedSecrets,
  };
}
