import * as z from 'zod';
import {
  getProfileIdByName,
  getEffectiveDefaultProfileId,
  getDefaultProfile,
} from './profile-service';
import { getBindingForRepo } from './repo-binding-service';
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
  repoFullName?: string;
  platform?: 'github' | 'gitlab';
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
  repoFullName,
  platform,
  envVars = {},
  setupCommands = [],
}: MergeProfileConfigurationArgs): Promise<MergeProfileConfigurationResult> {
  let mergedEnvVars = { ...envVars };
  let mergedSetupCommands = [...setupCommands];
  let encryptedSecrets: Record<string, EncryptedEnvelope> | undefined;

  // Layer 1: Repo binding profile (base)
  let repoBindingProfileId: string | null = null;
  if (repoFullName && platform) {
    repoBindingProfileId = await getBindingForRepo(owner, repoFullName, platform);
  }

  // Layer 2: User-selected or default profile (override)
  let overrideProfileId: string | null = null;
  if (profileName) {
    // Explicit profile name — resolve it
    if (owner.type === 'organization' && userId) {
      overrideProfileId = await getProfileIdByName(profileName, owner);
      if (!overrideProfileId) {
        overrideProfileId = await getProfileIdByName(profileName, { type: 'user', id: userId });
      }
    } else {
      overrideProfileId = await getProfileIdByName(profileName, owner);
    }

    if (!overrideProfileId) {
      throw new ProfileNotFoundError(profileName);
    }
  } else {
    // No explicit profile — fall back to default
    if (owner.type === 'organization' && userId) {
      overrideProfileId = await getEffectiveDefaultProfileId(userId, owner.id);
    } else {
      const defaultProfile = await getDefaultProfile(owner);
      overrideProfileId = defaultProfile?.id ?? null;
    }
  }

  // Deduplicate: if both layers resolve to the same profile, skip the base layer
  if (repoBindingProfileId && repoBindingProfileId === overrideProfileId) {
    repoBindingProfileId = null;
  }

  // Load all profile data in parallel
  const profilesToLoad: string[] = [];
  if (repoBindingProfileId) profilesToLoad.push(repoBindingProfileId);
  if (overrideProfileId) profilesToLoad.push(overrideProfileId);

  const profileData = await Promise.all(
    profilesToLoad.map(async profileId => {
      const [vars, commands] = await Promise.all([
        getVarsForSession(profileId),
        getCommandsForSession(profileId),
      ]);
      return { profileId, vars, commands };
    })
  );

  // Build the layered result: repo binding vars < override vars < manual vars
  const repoBindingData = repoBindingProfileId
    ? profileData.find(d => d.profileId === repoBindingProfileId)
    : null;
  const overrideData = overrideProfileId
    ? profileData.find(d => d.profileId === overrideProfileId)
    : null;

  // Process repo binding profile (base layer)
  const baseEnvVars: Record<string, string> = {};
  const baseSecrets: Record<string, EncryptedEnvelope> = {};
  const baseCommands: string[] = [];

  if (repoBindingData) {
    for (const variable of repoBindingData.vars) {
      if (variable.isSecret) {
        const parsed = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
        baseSecrets[variable.key] = parsed;
      } else {
        baseEnvVars[variable.key] = variable.value;
      }
    }
    baseCommands.push(...repoBindingData.commands);
  }

  // Process override profile
  const overrideEnvVars: Record<string, string> = {};
  const overrideSecrets: Record<string, EncryptedEnvelope> = {};
  const overrideCommands: string[] = [];

  if (overrideData) {
    for (const variable of overrideData.vars) {
      if (variable.isSecret) {
        const parsed = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
        overrideSecrets[variable.key] = parsed;
      } else {
        overrideEnvVars[variable.key] = variable.value;
      }
    }
    overrideCommands.push(...overrideData.commands);
  }

  // Merge env vars: base < override < manual
  mergedEnvVars = { ...baseEnvVars, ...overrideEnvVars, ...envVars };
  // Merge commands: base, then override, then manual
  mergedSetupCommands = [...baseCommands, ...overrideCommands, ...setupCommands];
  // Merge secrets: base < override (override wins on key collision)
  const allSecrets = { ...baseSecrets, ...overrideSecrets };
  if (Object.keys(allSecrets).length > 0) {
    encryptedSecrets = allSecrets;
  }

  return {
    envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
    setupCommands: mergedSetupCommands.length > 0 ? mergedSetupCommands : undefined,
    encryptedSecrets,
  };
}
