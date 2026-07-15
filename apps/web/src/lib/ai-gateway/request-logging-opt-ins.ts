import * as z from 'zod';
import { createCachedFetch } from '@/lib/cached-fetch';
import { redisClient } from '@/lib/redis';
import { REQUEST_LOGGING_OPT_INS_REDIS_KEY } from '@/lib/redis-keys';

export const RequestLoggingOptInSchema = z.object({
  id: z.string().uuid(),
  target_type: z.enum(['account', 'organization']),
  target_id: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(1).max(1000),
  added_by_email: z.string().email(),
  added_at: z.string().datetime(),
});

export const RequestLoggingOptInsSchema = z.array(RequestLoggingOptInSchema).max(500);

export type RequestLoggingOptIn = z.infer<typeof RequestLoggingOptInSchema>;

const CREATE_OPT_IN_SCRIPT = `
local entries = {}
local raw = redis.call('GET', KEYS[1])
if raw then entries = cjson.decode(raw) end
local new_entry = cjson.decode(ARGV[1])
for _, entry in ipairs(entries) do
  if entry.target_type == new_entry.target_type and entry.target_id == new_entry.target_id then
    return 0
  end
end
if #entries >= 500 then return -1 end
table.insert(entries, new_entry)
redis.call('SET', KEYS[1], cjson.encode(entries))
return 1
`;

const DELETE_OPT_IN_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local entries = cjson.decode(raw)
local remaining = {}
local deleted = 0
for _, entry in ipairs(entries) do
  if entry.id == ARGV[1] then
    deleted = 1
  else
    table.insert(remaining, entry)
  end
end
if deleted == 1 then
  if #remaining == 0 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('SET', KEYS[1], cjson.encode(remaining))
  end
end
return deleted
`;

const REQUEST_LOGGING_OPT_INS_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 10_000;

export function hasMatchingRequestLoggingOptIn(
  optIns: RequestLoggingOptIn[],
  params: { accountId: string | null; organizationId: string | null }
): boolean {
  return optIns.some(
    entry =>
      (entry.target_type === 'account' && entry.target_id === params.accountId) ||
      (entry.target_type === 'organization' && entry.target_id === params.organizationId)
  );
}

export async function getRequestLoggingOptIns(): Promise<RequestLoggingOptIn[]> {
  const raw = await redisClient.get<string>(REQUEST_LOGGING_OPT_INS_REDIS_KEY);
  if (!raw) return [];
  return RequestLoggingOptInsSchema.parse(JSON.parse(raw));
}

const getCachedRequestLoggingOptIns = createCachedFetch<RequestLoggingOptIn[]>(
  getRequestLoggingOptIns,
  REQUEST_LOGGING_OPT_INS_CACHE_TTL_MS,
  []
);

export async function createRequestLoggingOptIn(
  entry: RequestLoggingOptIn
): Promise<'created' | 'duplicate' | 'full'> {
  const validated = RequestLoggingOptInSchema.parse(entry);
  const result = await redisClient.eval<[string], number>(
    CREATE_OPT_IN_SCRIPT,
    [REQUEST_LOGGING_OPT_INS_REDIS_KEY],
    [JSON.stringify(validated)]
  );
  if (result === 1) return 'created';
  if (result === 0) return 'duplicate';
  return 'full';
}

export async function deleteRequestLoggingOptIn(id: string): Promise<boolean> {
  const result = await redisClient.eval<[string], number>(
    DELETE_OPT_IN_SCRIPT,
    [REQUEST_LOGGING_OPT_INS_REDIS_KEY],
    [id]
  );
  return result === 1;
}

export async function isDynamicallyOptedIntoRequestLogging(params: {
  accountId: string | null;
  organizationId: string | null;
}): Promise<boolean> {
  try {
    const optIns = await getCachedRequestLoggingOptIns();
    return hasMatchingRequestLoggingOptIn(optIns, params);
  } catch {
    return false;
  }
}
