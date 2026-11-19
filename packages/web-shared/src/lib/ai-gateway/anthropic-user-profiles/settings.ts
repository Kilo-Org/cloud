import { ai_gateway_config } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import {
  DEFAULT_ANTHROPIC_USER_PROFILES_SETTINGS,
  GatewayAnthropicUserProfilesConfigSchema,
  type AnthropicUserProfilesSettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { readDb, type db } from '@kilocode/web-shared/lib/drizzle';

export async function readAnthropicUserProfilesSettings(
  fromDb: typeof db
): Promise<AnthropicUserProfilesSettings> {
  const [row] = await fromDb
    .select({ config: ai_gateway_config.config })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row) return DEFAULT_ANTHROPIC_USER_PROFILES_SETTINGS;
  return GatewayAnthropicUserProfilesConfigSchema.parse(row.config).anthropic_user_profiles;
}

/** The Anthropic user profile settings for the gateway hot path, cached for one minute. */
export const getRuntimeAnthropicUserProfilesSettings =
  createCachedFetch<AnthropicUserProfilesSettings>(
    () => readAnthropicUserProfilesSettings(readDb),
    60_000,
    DEFAULT_ANTHROPIC_USER_PROFILES_SETTINGS,
    { name: 'runtimeAnthropicUserProfilesSettings' }
  );
