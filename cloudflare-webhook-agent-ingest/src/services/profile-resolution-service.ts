import { createDatabaseConnection } from '../db/database.js';
import { ProfileStore, type ResolvedProfileConfig } from '../db/stores/ProfileStore.js';
import { logger } from '../util/logger.js';

/**
 * Environment bindings required for profile resolution.
 */
export type ProfileResolutionEnv = {
  HYPERDRIVE: { connectionString: string };
};

type ResolveProfileParams = {
  profileId: string;
  userId?: string | null;
  orgId?: string | null;
};

export function getProfileResolutionService(env: ProfileResolutionEnv): ProfileResolutionService {
  return new ProfileResolutionService(env);
}

/**
 * Service for resolving agent environment profiles via Hyperdrive.
 *
 * Uses Hyperdrive to access the database directly for profile resolution
 * at webhook processing time.
 */
export class ProfileResolutionService {
  private store: ProfileStore | null = null;

  constructor(private env: ProfileResolutionEnv) {}

  private getStore(): ProfileStore {
    if (!this.store) {
      const db = createDatabaseConnection(this.env.HYPERDRIVE.connectionString);
      this.store = new ProfileStore(db);
    }
    return this.store;
  }

  /**
   * Resolve a profile by ID and return the full configuration.
   *
   * @param params.profileId - The profile UUID to resolve
   * @param params.userId - For user triggers, validates profile ownership
   * @param params.orgId - For org triggers, validates profile ownership
   * @returns Resolved profile config or null if not found/not authorized
   */
  async resolveProfile(params: ResolveProfileParams): Promise<ResolvedProfileConfig | null> {
    const store = this.getStore();

    logger.debug('Resolving profile via Hyperdrive', {
      profileId: params.profileId,
      userId: params.userId,
      orgId: params.orgId,
    });

    const config = await store.resolveProfile(params.profileId, params.userId, params.orgId);

    if (!config) {
      logger.warn('Profile not found or not authorized', {
        profileId: params.profileId,
        userId: params.userId,
        orgId: params.orgId,
      });
      return null;
    }

    logger.debug('Profile resolved successfully', {
      profileId: params.profileId,
      envVarCount: Object.keys(config.envVars).length,
      secretCount: Object.keys(config.encryptedSecrets).length,
      commandCount: config.setupCommands.length,
    });

    return config;
  }
}
