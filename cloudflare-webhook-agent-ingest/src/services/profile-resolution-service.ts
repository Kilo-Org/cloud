import {
  getWorkerDb,
  resolveProfile,
  type WorkerDb,
  type ResolvedProfileConfig,
} from '../db/queries.js';
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
  private db: WorkerDb | null = null;

  constructor(private env: ProfileResolutionEnv) {}

  private getDb(): WorkerDb {
    if (!this.db) {
      this.db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    }
    return this.db;
  }

  /**
   * Resolve a profile by ID and return the full configuration.
   *
   * @param params.profileId - The profile UUID to resolve
   * @param params.userId - For user triggers, validates profile ownership
   * @param params.orgId - For org triggers, validates profile ownership
   * @returns Resolved profile config or null if not found/not authorized
   */
  async resolveProfileConfig(params: ResolveProfileParams): Promise<ResolvedProfileConfig | null> {
    const db = this.getDb();

    logger.debug('Resolving profile via Hyperdrive', {
      profileId: params.profileId,
      userId: params.userId,
      orgId: params.orgId,
    });

    const config = await resolveProfile(db, params.profileId, params.userId, params.orgId);

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
