import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { syncAndStoreProviders } from '@/lib/ai-gateway/providers/openrouter/sync-providers';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await syncAndStoreProviders();

  return NextResponse.json(summary);
}
