import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { runOrganizationPassBonusRepairCron } from '@/lib/kilo-pass-org/bonus-repair-cron';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) throw new Error('CRON_SECRET is not configured in environment variables');

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    sentryLogger(
      'cron',
      'warning'
    )('SECURITY: Invalid organization Pass bonus repair authorization');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await runOrganizationPassBonusRepairCron();
  return NextResponse.json({ success: true, summary, timestamp: new Date().toISOString() });
}
