import { NextResponse } from 'next/server';
import { cleanupExpiredDeviceAuthRequests } from '@/lib/device-auth/device-auth';
import { cleanupExpiredAccessCodes } from '@/lib/kiloclaw/access-codes';
import { sentryLogger } from '@/lib/utils.server';

const CRON_SECRET = process.env['CRON_SECRET'];
if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

const BETTERSTACK_HEARTBEAT_URL =
  'https://uptime.betterstack.com/api/v1/heartbeat/Az5GGCNPJddhpKofgVYVpRnR';

/**
 * Cron job endpoint to cleanup expired device authorization requests
 */
export async function GET(request: Request) {
  // Verify authorization
  const authHeader = request.headers.get('authorization');

  // Check if authorization header matches the secret
  // Vercel sends: Authorization: Bearer <CRON_SECRET>
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? authHeader : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Execute cleanup
  const deletedCount = await cleanupExpiredDeviceAuthRequests();
  sentryLogger('cron', 'info')(`Cleaned up ${deletedCount} expired device auth requests`);

  const accessCodesDeleted = await cleanupExpiredAccessCodes();
  sentryLogger('cron', 'info')(`Cleaned up ${accessCodesDeleted} expired access codes`);

  // Send heartbeat to BetterStack on success
  await fetch(BETTERSTACK_HEARTBEAT_URL);

  return NextResponse.json({
    success: true,
    deletedCount,
    accessCodesDeleted,
    timestamp: new Date().toISOString(),
  });
}
