import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { getUserFromAuth } from '@/lib/user.server';
import { findUserById } from '@/lib/user';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { insertUsageRecord, type UsageMetaData } from '@/lib/processUsage';
import type { MicrodollarUsage } from '@/db/schema';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<
  NextResponse<{ success: true; inserted: { id: string; cost_mUsd: number } } | { error: string }>
> {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development mode' },
      { status: 403 }
    );
  }

  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const userId = decodeURIComponent((await params).id);
  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: `User not found: ${userId}` }, { status: 404 });
  }

  const body = (await request.json()) as unknown;
  const dollarAmount = (body as { dollarAmount?: unknown }).dollarAmount;
  if (typeof dollarAmount !== 'number' || !Number.isFinite(dollarAmount) || dollarAmount <= 0) {
    return NextResponse.json({ error: 'Invalid dollarAmount' }, { status: 400 });
  }

  const cost_mUsd = Math.ceil(dollarAmount * 1_000_000);
  const id = randomUUID();
  const created_at = new Date().toISOString();

  const coreUsageFields: MicrodollarUsage = {
    id,
    kilo_user_id: userId,
    organization_id: null,
    provider: 'dev-tools',
    cost: cost_mUsd,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at,
    model: 'admin-dev-insert-usage',
    requested_model: 'admin-dev-insert-usage',
    cache_discount: 0,
    has_error: false,
    abuse_classification: 0,
    inference_provider: 'dev-tools',
    project_id: null,
  };

  const metadataFields: UsageMetaData = {
    id,
    message_id: id,
    created_at,
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    user_prompt_prefix: `DEV admin insertUsageRecord $${dollarAmount}`.slice(0, 100),
    system_prompt_prefix: null,
    system_prompt_length: null,
    http_user_agent: 'admin-dev-tools',
    max_tokens: null,
    has_middle_out_transform: null,
    status_code: 200,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    is_byok: false,
    is_user_byok: false,
    streamed: false,
    cancelled: false,
    editor_name: null,
    has_tools: false,
    machine_id: null,
  };

  await insertUsageRecord(coreUsageFields, metadataFields);
  await forceImmediateExpirationRecomputation(userId);

  return NextResponse.json({ success: true, inserted: { id, cost_mUsd } });
}
