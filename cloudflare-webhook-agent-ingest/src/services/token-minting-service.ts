import { createDatabaseConnection } from '../db/database.js';
import { UserStore } from '../db/stores/UserStore.js';
import { signJwt } from '../util/jwt.js';
import { logger } from '../util/logger.js';

/**
 * Environment bindings required for token minting.
 */
export type TokenMintingEnv = {
  HYPERDRIVE: { connectionString: string };
  NEXTAUTH_SECRET: { get(): Promise<string> }; // Same secret used by kilocode-backend
  ENVIRONMENT: string;
};

type MintTokenParams = {
  userId?: string | null;
  orgId?: string | null;
  triggerId: string;
};

type MintTokenResult = {
  token: string;
  userId: string;
  isBot: boolean;
};

// Fixed botId for webhook tokens - used for attribution/analytics
const WEBHOOK_BOT_ID = 'webhook-bot';

export function getTokenMintingService(env: TokenMintingEnv): TokenMintingService {
  return new TokenMintingService(env);
}

/**
 * Service for minting short-lived API tokens for webhook processing.
 *
 * Uses Hyperdrive to access the database directly instead of calling
 * the kilocode-backend HTTP endpoint.
 */
export class TokenMintingService {
  private store: UserStore | null = null;
  private jwtSecret: string | null = null;

  constructor(private env: TokenMintingEnv) {}

  private getStore(): UserStore {
    if (!this.store) {
      const db = createDatabaseConnection(this.env.HYPERDRIVE.connectionString);
      this.store = new UserStore(db);
    }
    return this.store;
  }

  private async getJwtSecret(): Promise<string> {
    if (!this.jwtSecret) {
      this.jwtSecret = await this.env.NEXTAUTH_SECRET.get();
    }
    return this.jwtSecret;
  }

  /**
   * Mint a short-lived API token for webhook processing.
   *
   * For personal triggers: mints token for the real user
   * For org triggers: mints token for the webhook bot user
   */
  async mintToken(params: MintTokenParams): Promise<MintTokenResult> {
    const store = this.getStore();

    if (params.userId) {
      // Personal trigger - mint token for the real user
      logger.info('Token minting: lookup personal user', { userId: params.userId });
      const user = await store.findUserForToken(params.userId);

      if (!user) {
        throw new Error(`User not found: ${params.userId}`);
      }

      if (user.blocked_reason) {
        throw new Error(`User is blocked: ${user.blocked_reason}`);
      }

      const token = await this.signToken({
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        internalApiUse: true,
        createdOnPlatform: 'webhook',
      });

      logger.debug('Token minted for personal trigger', {
        triggerId: params.triggerId,
        userId: user.id,
      });

      return {
        token,
        userId: user.id,
        isBot: false,
      };
    } else if (params.orgId) {
      // Org trigger - mint token for the webhook bot user
      logger.info('Token minting: checking org exists', { orgId: params.orgId });
      const orgExists = await store.organizationExists(params.orgId);
      if (!orgExists) {
        throw new Error(`Organization not found: ${params.orgId}`);
      }

      logger.info('Token minting: ensuring bot user', { orgId: params.orgId });
      const botUser = await store.ensureBotUserForOrg(params.orgId);

      const token = await this.signToken({
        kiloUserId: botUser.id,
        apiTokenPepper: botUser.api_token_pepper,
        botId: WEBHOOK_BOT_ID,
        internalApiUse: true,
        createdOnPlatform: 'webhook',
      });

      logger.debug('Token minted for org trigger', {
        triggerId: params.triggerId,
        orgId: params.orgId,
        botId: botUser.id,
      });

      return {
        token,
        userId: botUser.id,
        isBot: true,
      };
    } else {
      throw new Error('Either userId or orgId must be provided');
    }
  }

  /**
   * Sign a JWT token with the given payload.
   */
  private async signToken(payload: {
    kiloUserId: string;
    apiTokenPepper: string | null;
    botId?: string;
    internalApiUse: boolean;
    createdOnPlatform: string;
  }): Promise<string> {
    // JWT_TOKEN_VERSION must match kilocode-backend's version (src/lib/tokens.ts)
    const JWT_TOKEN_VERSION = 3;
    const jwtSecret = await this.getJwtSecret();

    // signJwt is async (uses Web Crypto API)
    return await signJwt(
      {
        env: this.env.ENVIRONMENT === 'production' ? 'production' : 'development',
        kiloUserId: payload.kiloUserId,
        apiTokenPepper: payload.apiTokenPepper,
        version: JWT_TOKEN_VERSION,
        botId: payload.botId,
        internalApiUse: payload.internalApiUse,
        createdOnPlatform: payload.createdOnPlatform,
      },
      jwtSecret,
      { expiresIn: '1h' }
    );
  }
}
