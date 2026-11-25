import { ReadmitBenchmarkProfileRequestSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readmitBenchmarkProfile } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'auto_routing.benchmark_registry.readmit' },
  readmitPair
);

/** Re-admit one failed registry pair, clearing its failure history. */
async function readmitPair(request: NextRequest) {
  const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;
  setAdminAuditActor(user);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ReadmitBenchmarkProfileRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid re-admit request' }, { status: 400 });
  }
  const { entry, router } = parsed.data;
  addAdminAuditMetadata({ model: entry.model, variant: entry.variant, router });

  const result = await readmitBenchmarkProfile(entry, router);
  return NextResponse.json(result.body, { status: result.status });
}
