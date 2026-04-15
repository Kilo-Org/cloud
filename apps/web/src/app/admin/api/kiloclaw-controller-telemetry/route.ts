import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  queryDiskUsage,
  type AnalyticsEngineResponse,
  type ControllerTelemetryRow,
} from '@/lib/kiloclaw/disk-usage';
import { getUserFromAuth } from '@/lib/user.server';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | AnalyticsEngineResponse<ControllerTelemetryRow>>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const { searchParams } = new URL(request.url);
  const sandboxId = searchParams.get('sandboxId');

  if (!sandboxId) {
    return NextResponse.json({ error: 'Invalid or missing sandboxId' }, { status: 400 });
  }

  try {
    const result = await queryDiskUsage(sandboxId);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Analytics Engine request failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to query Analytics Engine';
    const status = message === 'Invalid or missing sandboxId' ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
