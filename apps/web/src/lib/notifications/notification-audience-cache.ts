import * as z from 'zod';

import { posthogQuery } from '@/lib/posthog-query';
import { redisClient } from '@/lib/redis';
import {
  byokProvidersNotificationRedisKey,
  deprecatedAutoModelsNotificationRedisKey,
  type RedisKey,
} from '@/lib/redis-keys';
import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeRow,
} from '@/lib/snowflake';

/**
 * Backing store for notifications targeted from analytics audiences.
 *
 * A daily cron writes one small Redis entry per user so notification polls read
 * only that user's entries instead of fetching and scanning full datasets on
 * every request.
 */

// Longer than the daily cron cadence so a few missed runs keep serving the
// previously computed audiences.
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7;

// Upstash REST has no MSET-with-TTL; pipeline SETs to avoid a round-trip per user.
const REDIS_WRITE_CHUNK_SIZE = 1000;

// Maps an extension `apiProvider` id to a user-facing label. Multiple ids can
// refer to the same underlying service (regional/plan/legacy variants), and we
// only list ids for services we actually support BYOK for via Kilo Gateway
// (see UserByokProviderIdSchema).
export const BYOK_PROVIDER_NOTIFICATION_LABELS: Record<string, string> = {
  // Anthropic / Claude
  anthropic: 'Claude API Key',
  claude: 'Claude API Key',

  // Amazon Bedrock
  bedrock: 'Amazon Bedrock API Key',
  'amazon-bedrock': 'Amazon Bedrock API Key',

  // Chutes
  chutes: 'Chutes API Key',

  // DeepSeek
  deepseek: 'DeepSeek API Key',
  deepseek1: 'DeepSeek API Key',
  'deepseek-v4': 'DeepSeek API Key',
  'deepseek-v4-pro': 'DeepSeek API Key',

  // Fireworks
  fireworks: 'Fireworks API Key',
  'fireworks-ai': 'Fireworks API Key',

  // Google AI (Gemini)
  gemini: 'Google AI API Key',
  google: 'Google AI API Key',

  // Moonshot AI / Kimi
  moonshot: 'Moonshot AI API Key',
  moonshotai: 'Moonshot AI API Key',
  kimi: 'Moonshot AI API Key',
  'kimi-for-coding': 'Kimi Code Plan',

  // MiniMax
  minimax: 'MiniMax Coding Plan',
  'minimax-coding-plan': 'MiniMax Coding Plan',

  // Mistral
  mistral: 'Mistral AI API Key',

  // Novita
  novita: 'Novita AI API Key',

  // xAI
  xai: 'SpaceXAI API Key',

  // Z.ai / Zhipu (GLM)
  zai: 'GLM Coding Plan',
  'z-ai': 'GLM Coding Plan',
  'zai-coding-plan': 'GLM Coding Plan',
  glm: 'GLM Coding Plan',
  zhipuai: 'GLM Coding Plan',
  'zhipuai-coding-plan': 'GLM Coding Plan',

  // Xiaomi MiMo
  xiaomi: 'Xiaomi MiMo API Key',
  'xiaomi-mimo': 'Xiaomi MiMo API Key',
  xiaomimimo: 'Xiaomi MiMo API Key',
  mimo: 'Xiaomi MiMo API Key',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan',

  // Ollama Cloud
  'ollama-cloud': 'Ollama Cloud API Key',
};

const BYOK_PROVIDER_NOTIFICATION_IDS = Object.keys(BYOK_PROVIDER_NOTIFICATION_LABELS);
const BYOK_PROVIDER_NOTIFICATION_ID_SET = new Set(BYOK_PROVIDER_NOTIFICATION_IDS);

const byokProviderNotificationSqlList = BYOK_PROVIDER_NOTIFICATION_IDS.map(
  provider => `'${provider.replaceAll("'", "''")}'`
).join(', ');

const BYOK_PROVIDER_QUERY = `
select u.id, ev.properties.apiProvider
from events ev
join postgres.kilocode_users u on u.google_user_email = ev.distinct_id
where ev.event = 'LLM Completion'
  and ev.properties.apiProvider is not null
  and ev.properties.apiProvider in (${byokProviderNotificationSqlList})
  and ev.properties.apiProvider not like '%kilo%'
  and ev.timestamp >= today() - toIntervalWeek(1)
  and ev.properties.outputTokens > 0
group by u.id, ev.properties.apiProvider
limit 5e5
`;

export const DEPRECATED_AUTO_MODEL_IDS = ['kilo-auto/frontier', 'kilo-auto/balanced'] as const;

const DEPRECATED_AUTO_MODELS_QUERY = `
select distinct kilo_user_id, auto_model
from microdollar_usage_daily
where usage_date >= dateadd(week, -1, current_date())
  and auto_model in (?, ?)
  and total_output_tokens > 0
  and kilo_user_id is not null
limit 500000
`;

const byokProviderRowsSchema = z.array(
  z.tuple([z.string(), z.string()]).transform(([userId, provider]) => ({ userId, provider }))
);

const cachedProvidersSchema = z.array(z.string());
const deprecatedAutoModelIdSchema = z.enum(DEPRECATED_AUTO_MODEL_IDS);
const deprecatedAutoModelRowsSchema = z.array(
  z
    .tuple([z.string().min(1), deprecatedAutoModelIdSchema])
    .transform(([userId, modelId]) => ({ userId, modelId }))
);
const cachedDeprecatedAutoModelsSchema = z.array(deprecatedAutoModelIdSchema);

export type ByokProviderRow = { userId: string; provider: string };
export type ByokProviderRowsFetcher = () => Promise<ByokProviderRow[]>;
export type DeprecatedAutoModelId = z.infer<typeof deprecatedAutoModelIdSchema>;
export type DeprecatedAutoModelRow = { userId: string; modelId: DeprecatedAutoModelId };
export type DeprecatedAutoModelRowsFetcher = () => Promise<DeprecatedAutoModelRow[]>;

export function getByokProviderNotificationLabel(provider: string): string | undefined {
  return BYOK_PROVIDER_NOTIFICATION_LABELS[provider];
}

const fetchByokProviderRowsFromPosthog: ByokProviderRowsFetcher = async () => {
  const response = await posthogQuery('sync-notification-audiences', BYOK_PROVIDER_QUERY);
  if (response.status !== 'ok') {
    throw new Error(`PostHog query failed: ${JSON.stringify(response.error)}`);
  }

  const parsed = byokProviderRowsSchema.safeParse(response.body.results ?? []);
  if (!parsed.success) {
    throw new Error(`Failed to parse BYOK provider rows: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export function parseDeprecatedAutoModelRows(rows: SnowflakeRow[]): DeprecatedAutoModelRow[] {
  const parsed = deprecatedAutoModelRowsSchema.safeParse(rows);
  if (!parsed.success) {
    throw new Error(`Failed to parse deprecated auto model rows: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

const fetchDeprecatedAutoModelRowsFromSnowflake: DeprecatedAutoModelRowsFetcher = async () => {
  const config = resolveSnowflakeConfig();
  if (!config) {
    throw new Error('Snowflake is not configured');
  }

  const rows = await executeSnowflakeStatement({
    config,
    statement: DEPRECATED_AUTO_MODELS_QUERY,
    bindings: DEPRECATED_AUTO_MODEL_IDS.map(value => ({ type: 'TEXT' as const, value })),
    timeoutSeconds: 60,
  });

  return parseDeprecatedAutoModelRows(rows);
};

export function groupProvidersByUser(rows: ByokProviderRow[]): Map<string, string[]> {
  const byUser = new Map<string, string[]>();
  for (const { userId, provider } of rows) {
    if (!BYOK_PROVIDER_NOTIFICATION_ID_SET.has(provider)) continue;

    const existing = byUser.get(userId);
    if (existing) {
      if (!existing.includes(provider)) existing.push(provider);
    } else {
      byUser.set(userId, [provider]);
    }
  }
  return byUser;
}

export function groupDeprecatedAutoModelsByUser(
  rows: DeprecatedAutoModelRow[]
): Map<string, DeprecatedAutoModelId[]> {
  const byUser = new Map<string, DeprecatedAutoModelId[]>();
  for (const { userId, modelId } of rows) {
    const existing = byUser.get(userId);
    if (existing) {
      if (!existing.includes(modelId)) existing.push(modelId);
    } else {
      byUser.set(userId, [modelId]);
    }
  }
  return byUser;
}

async function writeNotificationAudienceEntries(
  entries: [string, string[]][],
  redisKeyForUser: (userId: string) => RedisKey
): Promise<void> {
  for (let i = 0; i < entries.length; i += REDIS_WRITE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + REDIS_WRITE_CHUNK_SIZE);
    const pipeline = redisClient.pipeline();
    for (const [userId, values] of chunk) {
      pipeline.set(redisKeyForUser(userId), JSON.stringify(values), {
        ex: REDIS_TTL_SECONDS,
      });
    }
    await pipeline.exec();
  }
}

export type SyncNotificationAudienceResult = {
  rowCount: number;
  userCount: number;
};

// `fetchRows` is injectable so the sync can be tested without the PostHog API.
export async function syncByokProviderNotificationsToRedis(
  fetchRows: ByokProviderRowsFetcher = fetchByokProviderRowsFromPosthog
): Promise<SyncNotificationAudienceResult> {
  const rows = await fetchRows();
  const byUser = groupProvidersByUser(rows);
  await writeNotificationAudienceEntries([...byUser.entries()], byokProvidersNotificationRedisKey);

  return { rowCount: rows.length, userCount: byUser.size };
}

export async function syncDeprecatedAutoModelNotificationsToRedis(
  fetchRows: DeprecatedAutoModelRowsFetcher = fetchDeprecatedAutoModelRowsFromSnowflake
): Promise<SyncNotificationAudienceResult> {
  const rows = await fetchRows();
  const byUser = groupDeprecatedAutoModelsByUser(rows);
  await writeNotificationAudienceEntries(
    [...byUser.entries()],
    deprecatedAutoModelsNotificationRedisKey
  );

  return { rowCount: rows.length, userCount: byUser.size };
}

export type SyncNotificationAudiencesResult = {
  byokProviders: SyncNotificationAudienceResult;
  deprecatedAutoModels: SyncNotificationAudienceResult;
};

export async function syncNotificationAudiencesToRedis(): Promise<SyncNotificationAudiencesResult> {
  const [byokProviders, deprecatedAutoModels] = await Promise.all([
    syncByokProviderNotificationsToRedis(),
    syncDeprecatedAutoModelNotificationsToRedis(),
  ]);

  return { byokProviders, deprecatedAutoModels };
}

// Returns [] for a missing or malformed entry, so callers fail open and skip
// the notification.
export async function getByokProvidersForUser(userId: string): Promise<string[]> {
  const cached = await redisClient.get<string>(byokProvidersNotificationRedisKey(userId));
  if (cached === null) return [];

  try {
    const parsed = cachedProvidersSchema.safeParse(JSON.parse(cached));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function getDeprecatedAutoModelsForUser(
  userId: string
): Promise<DeprecatedAutoModelId[]> {
  const cached = await redisClient.get<string>(deprecatedAutoModelsNotificationRedisKey(userId));
  if (cached === null) return [];

  try {
    const parsed = cachedDeprecatedAutoModelsSchema.safeParse(JSON.parse(cached));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
