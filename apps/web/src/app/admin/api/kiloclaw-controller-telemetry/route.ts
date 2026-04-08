import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getEnvVariable } from '@/lib/dotenvx';

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function buildQuery(sandboxId: string): string {
  return `SELECT
  timestamp,
  blob1 AS sandbox_id,
  blob8 AS machine_id,
  double7 AS disk_used_bytes,
  double8 AS disk_total_bytes
FROM kiloclaw_controller_telemetry
WHERE index1 = '${sandboxId}'
ORDER BY timestamp DESC
LIMIT 1
FORMAT JSON`;
}

type AnalyticsEngineResponse = {
  data: Record<string, unknown>[];
  meta: { name: string; type: string }[];
  rows: number;
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | AnalyticsEngineResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const { searchParams } = new URL(request.url);
  const sandboxId = searchParams.get('sandboxId');

  if (!sandboxId || !isSafeIdentifier(sandboxId)) {
    return NextResponse.json({ error: 'Invalid or missing sandboxId' }, { status: 400 });
  }

  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const token = getEnvVariable('CF_ANALYTICS_ENGINE_TOKEN');

  if (!accountId || !token) {
    return NextResponse.json(
      { error: 'Missing Cloudflare Analytics Engine configuration' },
      { status: 500 }
    );
  }

  const sqlQuery = buildQuery(sandboxId);

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: sqlQuery,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Analytics Engine API error:', response.status, errorText);
      return NextResponse.json(
        { error: `Analytics Engine API error: ${response.status}` },
        { status: 500 }
      );
    }

    const result: AnalyticsEngineResponse = await response.json();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Analytics Engine request failed:', error);
    return NextResponse.json({ error: 'Failed to query Analytics Engine' }, { status: 500 });
  }
}
