import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getEnvVariable } from '@/lib/dotenvx';

type QueryType = 'instance-events';

const validQueryTypes = new Set<QueryType>(['instance-events']);

function buildQuery(queryType: QueryType, sandboxId: string): string {
  // sandboxId is validated as base64url [A-Za-z0-9_-]+ before reaching here
  switch (queryType) {
    case 'instance-events':
      return `SELECT
  timestamp,
  blob1 AS event,
  blob3 AS delivery,
  blob4 AS route,
  blob5 AS error,
  blob6 AS fly_app_name,
  blob7 AS fly_machine_id,
  blob9 AS status,
  blob10 AS openclaw_version,
  blob11 AS image_tag,
  blob12 AS fly_region,
  blob13 AS label,
  double1 AS duration_ms,
  double2 AS value
FROM kiloclaw_events
WHERE
  blob8 = '${sandboxId}'
  AND (blob3 = 'do' OR blob3 = 'reconcile')
ORDER BY timestamp DESC
LIMIT 20
FORMAT JSON`;
  }
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
  const queryType = searchParams.get('query');
  const sandboxId = searchParams.get('sandboxId');

  if (!queryType || !validQueryTypes.has(queryType as QueryType)) {
    return NextResponse.json(
      { error: `Invalid query type. Must be one of: ${[...validQueryTypes].join(', ')}` },
      { status: 400 }
    );
  }

  if (!sandboxId || !/^[A-Za-z0-9_-]+$/.test(sandboxId)) {
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

  const sqlQuery = buildQuery(queryType as QueryType, sandboxId);

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
}
