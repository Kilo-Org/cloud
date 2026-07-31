import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { dispatchOrganizationPassBlockedNotifications } from '@/lib/kilo-pass-org/notifications';
import { runOrganizationPassIssuanceCron } from '@/lib/kilo-pass-org/service';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) throw new Error('CRON_SECRET is not configured in environment variables');

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    sentryLogger('cron', 'warning')('SECURITY: Invalid organization Pass issuance authorization');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await runOrganizationPassIssuanceCron(db);
  for (const failure of summary.failures) {
    sentryLogger('kilo-pass-org-issuance', 'error')('Agreement issuance failed', {
      agreementId: failure.agreementId,
      error: failure.message,
    });
  }
  let notifications: Awaited<ReturnType<typeof dispatchOrganizationPassBlockedNotifications>>;
  try {
    // Dispatch after issuance so newly created blocked-run deliveries are included.
    notifications = await dispatchOrganizationPassBlockedNotifications(db);
  } catch (error) {
    sentryLogger('kilo-pass-org-issuance', 'error')('Notification dispatch failed', { error });
    return NextResponse.json(
      { success: false, summary, error: 'Notification dispatch failed' },
      { status: 500 }
    );
  }
  const success = summary.failed === 0 && notifications.failed === 0;
  return NextResponse.json(
    { success, summary, notifications, timestamp: new Date().toISOString() },
    { status: success ? 200 : 500 }
  );
}
