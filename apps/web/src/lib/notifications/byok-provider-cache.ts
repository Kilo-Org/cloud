import * as z from 'zod';

import { posthogQuery } from '@/lib/posthog-query';
import { redisClient } from '@/lib/redis';
import { byokProvidersNotificationRedisKey } from '@/lib/redis-keys';

/**
 * Backing store for the "Try BYOK for Kilo Gateway" notification.
 *
 * A daily cron writes one small Redis entry per user (the BYOK provider ids
 * that user has used) so notification polls read only that user's entry,
 * instead of fetching the full ~700KB dataset and scanning it on every request
 * (which degraded badly on Vercel, where the in-process cache rarely survives
 * between invocations).
 */

// Longer than the daily cron cadence so a few missed runs degrade to
// "no notification" rather than serving nothing.
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
  xai: 'xAI API Key',

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

const byokProviderRowsSchema = z.array(
  z.tuple([z.string(), z.string()]).transform(([userId, provider]) => ({ userId, provider }))
);

const cachedProvidersSchema = z.array(z.string());

export type ByokProviderRow = { userId: string; provider: string };
export type ByokProviderRowsFetcher = () => Promise<ByokProviderRow[]>;

export function getByokProviderNotificationLabel(provider: string): string | undefined {
  return BYOK_PROVIDER_NOTIFICATION_LABELS[provider];
}

const fetchByokProviderRowsFromPosthog: ByokProviderRowsFetcher = async () => {
  const response = await posthogQuery('sync-byok-provider-notifications', BYOK_PROVIDER_QUERY);
  if (response.status !== 'ok') {
    throw new Error(`PostHog query failed: ${JSON.stringify(response.error)}`);
  }

  const parsed = byokProviderRowsSchema.safeParse(response.body.results ?? []);
  if (!parsed.success) {
    throw new Error(`Failed to parse BYOK provider rows: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
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

export type SyncByokProviderNotificationsResult = {
  rowCount: number;
  userCount: number;
};

// `fetchRows` is injectable so the sync can be tested without the PostHog API.
export async function syncByokProviderNotificationsToRedis(
  fetchRows: ByokProviderRowsFetcher = fetchByokProviderRowsFromPosthog
): Promise<SyncByokProviderNotificationsResult> {
  const rows = await fetchRows();
  const byUser = groupProvidersByUser(rows);

  const entries = [...byUser.entries()];
  for (let i = 0; i < entries.length; i += REDIS_WRITE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + REDIS_WRITE_CHUNK_SIZE);
    const pipeline = redisClient.pipeline();
    for (const [userId, providers] of chunk) {
      pipeline.set(byokProvidersNotificationRedisKey(userId), JSON.stringify(providers), {
        ex: REDIS_TTL_SECONDS,
      });
    }
    await pipeline.exec();
  }

  return { rowCount: rows.length, userCount: byUser.size };
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
