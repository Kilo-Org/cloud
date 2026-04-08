import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getEnvVariable } from '@/lib/dotenvx';

type QueryType =
  | 'overview'
  | 'events-timeseries'
  | 'error-rates'
  | 'top-users'
  | 'latency-by-event'
  | 'delivery-breakdown';

const validQueryTypes = new Set<QueryType>([
  'overview',
  'events-timeseries',
  'error-rates',
  'top-users',
  'latency-by-event',
  'delivery-breakdown',
]);

function buildQuery(queryType: QueryType, hours: number): string {
  switch (queryType) {
    case 'overview':
      return `SELECT 
  SUM(_sample_interval) as total_events,
  count(DISTINCT blob2) as unique_users,
  SUM(IF(blob3 IN ('http', 'trpc'), _sample_interval * double1, 0)) / SUM(IF(blob3 IN ('http', 'trpc'), _sample_interval, 1)) as avg_latency_ms,
  SUM(IF(blob5 != '', _sample_interval, 0)) as error_count
FROM gastown_events
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
FORMAT JSON`;

    case 'events-timeseries':
      return `SELECT 
  toStartOfHour(timestamp) as hour,
  blob1 as event,
  SUM(_sample_interval) as count
FROM gastown_events
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
GROUP BY hour, event
ORDER BY hour ASC
FORMAT JSON`;

    case 'error-rates':
      return `SELECT 
  blob1 as event,
  SUM(_sample_interval) as total,
  SUM(IF(blob5 = '', _sample_interval, 0)) as success_count,
  SUM(IF(blob5 != '', _sample_interval, 0)) as error_count
FROM gastown_events
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
GROUP BY event
HAVING total > 0
ORDER BY total DESC
LIMIT 30
FORMAT JSON`;

    case 'top-users':
      return `SELECT 
  blob2 as user_id,
  SUM(_sample_interval) as total_events,
  SUM(IF(blob5 != '', _sample_interval, 0)) as error_count,
  SUM(IF(blob3 IN ('http', 'trpc'), _sample_interval * double1, 0)) / SUM(IF(blob3 IN ('http', 'trpc'), _sample_interval, 1)) as avg_latency_ms
FROM gastown_events
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
  AND blob2 != ''
GROUP BY user_id
ORDER BY total_events DESC
LIMIT 20
FORMAT JSON`;

    case 'latency-by-event':
      return `SELECT 
  blob1 as event,
  blob3 as delivery,
  SUM(_sample_interval * double1) / SUM(_sample_interval) as avg_latency_ms,
  SUM(_sample_interval) as count
FROM gastown_events
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
  AND blob3 IN ('http', 'trpc')
GROUP BY event, delivery
HAVING count > 5
ORDER BY avg_latency_ms DESC
LIMIT 30
FORMAT JSON`;

    case 'delivery-breakdown':
      return `SELECT 
  toStartOfHour(timestamp) as hour,
  blob3 as delivery,
  SUM(_sample_interval) as count
FROM gastown_events
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
GROUP BY hour, delivery
ORDER BY hour ASC
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
  const hours = Math.max(1, Math.min(720, parseInt(searchParams.get('hours') || '24', 10) || 24));

  if (!queryType || !validQueryTypes.has(queryType as QueryType)) {
    return NextResponse.json(
      { error: `Invalid query type. Must be one of: ${[...validQueryTypes].join(', ')}` },
      { status: 400 }
    );
  }

  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const token = getEnvVariable('CF_ANALYTICS_ENGINE_TOKEN');

  if (!accountId || !token) {
    return NextResponse.json(
      { error: 'Missing Cloudflare Analytics Engine configuration' },
      { status: 500 }
    );
  }

  const sqlQuery = buildQuery(queryType as QueryType, hours);

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
