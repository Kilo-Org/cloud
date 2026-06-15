import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { refreshExpiringAgentCardConnections } from '@/lib/kiloclaw/agentcard-token-refresh';

// Agentcard access tokens live ~1h. This cron runs every 10 minutes and
// refreshes any connection whose token expires within the next 20 minutes, so
// a fresh token is always pushed to the worker well before the old one dies.
const REFRESH_WINDOW_MS = 20 * 60 * 1000;

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await refreshExpiringAgentCardConnections({ withinMs: REFRESH_WINDOW_MS });

  return NextResponse.json({ ...result, timestamp: new Date().toISOString() });
}
