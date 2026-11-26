import 'server-only';

import {
  BenchmarkUsageReceiptRequestSchema,
  parseBenchmarkProjectId,
  BENCHMARK_PLATFORM_PROJECT_ID,
  type BenchmarkUsageReceipt,
} from '@kilocode/auto-routing-contracts';
import { inArray } from 'drizzle-orm';
import { microdollar_usage } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { matchesInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

/**
 * The authenticated read that turns a deferred usage id into an actual charge.
 *
 * The gateway knows `microdollar_usage.id` before the provider call, but the write is deferred
 * with `after()`, so a 200 does not prove a committed row. This route answers by primary key
 * against the primary: `recorded` means the row exists with its cost, `pending` means it does
 * not. A missing row is never free and is never retried here — the caller only discloses it.
 *
 * Because the read is keyed by a caller-supplied id, it only answers for a row the benchmark
 * path wrote: the project must be the platform value or a canonical pool id. Any other row is
 * reported `pending` without its cost, payer or project, so the endpoint cannot be used to read
 * unrelated usage and cannot become a second billing path.
 */
export async function handleBenchmarkUsageReceipts(request: Request): Promise<Response> {
  const unauthorized = await authorize(request);
  if (unauthorized) return unauthorized;

  const parsed = BenchmarkUsageReceiptRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }

  const rows = await db
    .select({
      id: microdollar_usage.id,
      cost: microdollar_usage.cost,
      kilo_user_id: microdollar_usage.kilo_user_id,
      organization_id: microdollar_usage.organization_id,
      project_id: microdollar_usage.project_id,
      model: microdollar_usage.model,
      requested_model: microdollar_usage.requested_model,
      created_at: microdollar_usage.created_at,
    })
    .from(microdollar_usage)
    .where(inArray(microdollar_usage.id, parsed.data.usageIds));

  const byId = new Map(rows.map(row => [row.id, row]));
  const receipts: BenchmarkUsageReceipt[] = parsed.data.usageIds.map(usageId => {
    const row = byId.get(usageId);
    // A row outside the reserved benchmark namespace is not this endpoint's to disclose.
    const project = row ? parseBenchmarkProjectId(row.project_id) : null;
    const isBenchmarkRow = row?.project_id === BENCHMARK_PLATFORM_PROJECT_ID || project !== null;
    if (!row || !isBenchmarkRow) {
      return {
        usageId,
        status: 'pending',
        microdollars: null,
        payerType: null,
        payerId: null,
        projectId: null,
        requestedModel: null,
        model: null,
        createdAt: null,
      };
    }
    return {
      usageId,
      status: 'recorded',
      microdollars: Math.max(0, row.cost),
      payerType: row.organization_id ? 'organization' : 'user',
      payerId: row.organization_id ?? row.kilo_user_id,
      projectId: row.project_id ?? null,
      // `requested_model` is what the case signed; `model` is what the provider reported.
      requestedModel: row.requested_model ?? null,
      model: row.model ?? null,
      // PostgreSQL renders `timestamptz` as `+00`, which is not strict ISO 8601.
      createdAt: new Date(row.created_at).toISOString(),
    };
  });

  return Response.json({ receipts });
}

async function authorize(request: Request): Promise<Response | null> {
  const presented =
    request.headers.get('x-internal-api-key') ?? request.headers.get('x-internal-secret');
  if (!(await matchesInternalApiSecret(presented))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
