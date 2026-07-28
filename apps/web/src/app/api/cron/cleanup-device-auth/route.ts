import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { cleanupExpiredDeviceAuthRequests } from '@/lib/device-auth/device-auth';
import { cleanupExpiredAccessCodes } from '@/lib/kiloclaw/access-codes';
import { sentryLogger } from '@/lib/utils.server';

const CRON_SECRET = process.env['CRON_SECRET'];
if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

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
    )(`SECURITY: ${authHeader ? 'Invalid' : 'Missing'} CRON job authorization`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_device_auth',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const deletedCount = await cleanupExpiredDeviceAuthRequests();
    sentryLogger('cron', 'info')(`Cleaned up ${deletedCount} expired device auth requests`);

    const accessCodesDeleted = await cleanupExpiredAccessCodes();
    sentryLogger('cron', 'info')(`Cleaned up ${accessCodesDeleted} expired access codes`);
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_device_auth_request_count: deletedCount,
        deleted_access_code_count: accessCodesDeleted,
      })
    );

    return NextResponse.json({
      success: true,
      deletedCount,
      accessCodesDeleted,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
