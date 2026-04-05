import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { syncAndStoreProviders } from '@/lib/providers/openrouter/sync-providers';

const BETTERSTACK_HEARTBEAT_URL =
  'https://uptime.betterstack.com/api/v1/heartbeat/ofE8LJrqEGcDzh6GTvXK6vWG';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await syncAndStoreProviders();

  await fetch(BETTERSTACK_HEARTBEAT_URL);
  // don't report failures to betterstack immediately, it's fine if this fails occasionally

  return NextResponse.json(summary);
}
