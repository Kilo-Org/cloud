import { and, eq } from 'drizzle-orm';
import { gateway_custom_upstreams } from '@kilocode/db/schema';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';

export type CustomUpstreamResolved = {
  providerId: string;
  upstreamModelId: string;
  apiKey: string;
  baseUrl: string;
  extraHeaders: Record<string, string>;
};

export async function getCustomUpstreamForModel(
  db: typeof import('@/lib/drizzle').db,
  owner: { organizationId?: string; userId: string },
  requestedModel: string
): Promise<CustomUpstreamResolved | null> {
  const [providerId, ...rest] = requestedModel.split('/');
  const upstreamModelId = rest.join('/');
  if (!providerId || !upstreamModelId) return null;

  const [row] = await db
    .select()
    .from(gateway_custom_upstreams)
    .where(
      and(
        eq(gateway_custom_upstreams.provider_id, providerId),
        eq(gateway_custom_upstreams.is_enabled, true),
        owner.organizationId
          ? eq(gateway_custom_upstreams.organization_id, owner.organizationId)
          : eq(gateway_custom_upstreams.kilo_user_id, owner.userId)
      )
    );
  if (!row) return null;
  const apiKey = decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  const extraHeaders = row.encrypted_extra_headers
    ? (JSON.parse(decryptApiKey(row.encrypted_extra_headers, BYOK_ENCRYPTION_KEY)) as Record<
        string,
        string
      >)
    : {};
  return { providerId, upstreamModelId, apiKey, baseUrl: row.base_url, extraHeaders };
}
