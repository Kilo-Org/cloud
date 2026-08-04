import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { cleanupExpiredDeviceAuthRequests } from '@/lib/device-auth/device-auth';
import { cleanupExpiredAdmissionChallenges } from '@/lib/auth/native-admission';
import { cleanupExpiredAccessCodes } from '@/lib/kiloclaw/access-codes';
import { cleanupExpiredInstallStates } from '@/lib/integrations/github/install-state';
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

    const challengesDeleted = await cleanupExpiredAdmissionChallenges();
    sentryLogger('cron', 'info')(`Cleaned up ${challengesDeleted} expired admission challenges`);

    const accessCodesDeleted = await cleanupExpiredAccessCodes();
    sentryLogger('cron', 'info')(`Cleaned up ${accessCodesDeleted} expired access codes`);

    const installStatesDeleted = await cleanupExpiredInstallStates();
    sentryLogger('cron', 'info')(`Cleaned up ${installStatesDeleted} expired install states`);

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_device_auth_request_count: deletedCount,
        deleted_admission_challenge_count: challengesDeleted,
        deleted_access_code_count: accessCodesDeleted,
        deleted_install_state_count: installStatesDeleted,
      })
    );

    return NextResponse.json({
      success: true,
      deletedCount,
      challengesDeleted,
      accessCodesDeleted,
      installStatesDeleted,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
