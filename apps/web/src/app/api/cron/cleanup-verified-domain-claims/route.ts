import { NextResponse } from 'next/server';
import * as z from 'zod';

import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { runVerifiedDomainClaimCleanup } from '@/lib/organizations/verified-domain-cleanup';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

const DEFAULT_DRY_RUN_LIMIT = 100;
const DEFAULT_EXECUTE_LIMIT = 5;
const MAX_LIMIT = 500;

const QuerySchema = z.object({
  execute: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  organizationIds: z.array(z.uuid()),
});

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    execute: searchParams.get('execute') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
    organizationIds: searchParams.getAll('organizationId'),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', issues: z.treeifyError(parsed.error) },
      { status: 400 }
    );
  }

  const execute = parsed.data.execute === 'true';
  const report = await runVerifiedDomainClaimCleanup({
    execute,
    limit: parsed.data.limit ?? (execute ? DEFAULT_EXECUTE_LIMIT : DEFAULT_DRY_RUN_LIMIT),
    organizationIds: parsed.data.organizationIds,
  });

  return NextResponse.json(report, { status: report.summary.failed > 0 ? 500 : 200 });
}
