import { type NextRequest } from 'next/server';
import { authenticateHomeWidget } from '@/lib/auth/home-widget-credential';
import { buildHomeWidgetResponseForUser } from '@/lib/glanceable-agents-snapshot-server';
import { homeWidgetJson, homeWidgetRequest } from '@/lib/home-widget-http';

/** The read-only widget audience is accepted here, never by ordinary tRPC authentication. */
export async function GET(request: NextRequest) {
  return homeWidgetRequest(async () => {
    const principal = await authenticateHomeWidget(request.headers);
    const response = await buildHomeWidgetResponseForUser(principal);
    return homeWidgetJson(response);
  });
}
