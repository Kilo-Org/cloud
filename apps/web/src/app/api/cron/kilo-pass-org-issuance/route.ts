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
  // Dispatch after issuance so newly created blocked-run deliveries are included.
  const notifications = await dispatchOrganizationPassBlockedNotifications(db);
  for (const failure of summary.failures) {
    sentryLogger('kilo-pass-org-issuance', 'error')('Agreement issuance failed', {
      agreementId: failure.agreementId,
      error: failure.message,
    });
  }
  return NextResponse.json({
    success: true,
    summary,
    notifications,
    timestamp: new Date().toISOString(),
  });
}
