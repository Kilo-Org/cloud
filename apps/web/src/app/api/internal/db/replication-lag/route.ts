import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { NextResponse } from 'next/server';

import { collectReplicationHealth } from '@/lib/replication-health';

export async function GET(request: Request) {
  const unauthorized = await authorizeInternalApiRequest(request, 'db_replication_lag');
  if (unauthorized) return unauthorized;

  const report = await collectReplicationHealth();

  return NextResponse.json(report);
}
