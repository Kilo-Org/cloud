import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getEnvVariable } from '@/lib/dotenvx';

type QueryType = 'instance-events' | 'all-events';

const validQueryTypes = new Set<QueryType>(['instance-events', 'all-events']);

/** High-frequency polling events excluded from the "All Events" tab to reduce noise. */
const NOISY_ALL_EVENTS_EXCLUDED = [
  'platform.controller-version.get',
  'platform.volume-snapshots.get',
  'platform.debug-status.get',
  'platform.status.get',
  'platform.gateway.ready.get',
  'platform.gateway.status.get',
] as const;

// Validates that a value is safe to interpolate into SQL (alphanumeric, hyphens, underscores only)
function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

type AllEventsParams = {
  sandboxId: string;
  userId: string;
  flyAppName: string | null;
  flyMachineId: string | null;
  offset: number;
};

function buildQuery(queryType: QueryType, sandboxId: string, params?: AllEventsParams): string {
  switch (queryType) {
    case 'instance-events':
      // sandboxId is validated as base64url [A-Za-z0-9_-]+ before reaching here
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

    case 'all-events': {
      // All identifiers are validated before reaching here
      const p = params as AllEventsParams;
      const orClauses = [`blob2 = '${p.userId}'`, `blob8 = '${p.sandboxId}'`];
      if (p.flyMachineId) orClauses.push(`blob7 = '${p.flyMachineId}'`);
      if (p.flyAppName) orClauses.push(`blob6 = '${p.flyAppName}'`);
      return `SELECT
  timestamp,
  blob1 AS event,
  blob2 AS user_id,
  blob3 AS delivery,
  blob4 AS route,
  blob5 AS error,
  blob6 AS fly_app_name,
  blob7 AS fly_machine_id,
  blob8 AS sandbox_id,
  blob9 AS status,
  blob10 AS openclaw_version,
  blob11 AS image_tag,
  blob12 AS fly_region,
  blob13 AS label,
  double1 AS duration_ms,
  double2 AS value
FROM kiloclaw_events
WHERE
  (${orClauses.join(' OR ')})
  AND blob3 IN ('http', 'do', 'reconcile', 'queue')
  AND blob1 NOT IN (${NOISY_ALL_EVENTS_EXCLUDED.map(e => `'${e}'`).join(', ')})
ORDER BY timestamp DESC
LIMIT 100
OFFSET ${p.offset}
FORMAT JSON`;
    }
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

  let sqlQuery: string;

  if (queryType === 'all-events') {
    const userId = searchParams.get('userId');
    const flyAppName = searchParams.get('flyAppName');
    const flyMachineId = searchParams.get('flyMachineId');
    const offsetParam = searchParams.get('offset');
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

    if (!userId || !isSafeIdentifier(userId)) {
      return NextResponse.json({ error: 'Invalid or missing userId' }, { status: 400 });
    }
    if (flyAppName && !isSafeIdentifier(flyAppName)) {
      return NextResponse.json({ error: 'Invalid flyAppName' }, { status: 400 });
    }
    if (flyMachineId && !isSafeIdentifier(flyMachineId)) {
      return NextResponse.json({ error: 'Invalid flyMachineId' }, { status: 400 });
    }
    if (isNaN(offset) || offset < 0) {
      return NextResponse.json({ error: 'Invalid offset' }, { status: 400 });
    }

    sqlQuery = buildQuery('all-events', sandboxId, {
      sandboxId,
      userId,
      flyAppName: flyAppName ?? null,
      flyMachineId: flyMachineId ?? null,
      offset,
    });
  } else {
    sqlQuery = buildQuery(queryType as QueryType, sandboxId);
  }

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
