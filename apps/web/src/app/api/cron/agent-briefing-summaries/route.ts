import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { generatePendingAgentBriefings } from '@/lib/agent-briefing/sweep';

export const maxDuration = 800;
export async function GET(request: Request) {
  if (!CRON_SECRET || !isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json({ success: true, ...(await generatePendingAgentBriefings()) });
}
