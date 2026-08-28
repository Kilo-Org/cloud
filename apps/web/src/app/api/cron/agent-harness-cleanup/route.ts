import { NextResponse } from 'next/server';
import { createQuickChatRuntime } from '@kilocode/db/quick-chat-runtime';
import { CRON_SECRET, INTERNAL_API_SECRET, NEXTAUTH_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { db } from '@/lib/drizzle';
import { drainLegacyHistory } from '@/lib/agent-harness/history';
import {
  createHarnessRetirementStore,
  drainHarnessRetirements,
  sendHarnessMaintenance,
  type HarnessMaintenanceRequest,
} from '@/lib/agent-harness/retirement';

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!CRON_SECRET || !isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const send = (work: HarnessMaintenanceRequest, dispatchId: string) =>
    sendHarnessMaintenance(
      process.env.AGENT_HARNESS_API_URL,
      NEXTAUTH_SECRET,
      INTERNAL_API_SECRET,
      work,
      dispatchId
    );
  const store = createHarnessRetirementStore(db);
  const swept = await store.sweep();
  const purge = await drainHarnessRetirements(store, send);
  const ingress = await drainLegacyHistory(
    createQuickChatRuntime(db),
    input => send({ type: 'importLegacy', protocolVersion: 1, ...input }, input.message.id),
    { limit: 10 }
  );
  return NextResponse.json({
    success: true,
    swept,
    purge,
    ingress: {
      acknowledged: ingress.filter(item => item.status === 'acknowledged').length,
      retry: ingress.filter(item => item.status === 'retry').length,
      rejected: ingress.filter(item => item.status === 'rejected').length,
    },
  });
}
