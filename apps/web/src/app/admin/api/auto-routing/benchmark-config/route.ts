import { BenchmarkConfigSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  gatewayChatApisForModel,
  modelServesAllGatewayChatApis,
} from '@/lib/ai-gateway/model-api-kinds';
import { findExperimentReservedModelIds } from '@/lib/ai-gateway/experiments/reserved-ids';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getBenchmarkConfig();
  return NextResponse.json(result.body, { status: result.status });
}

export async function PUT(request: NextRequest) {
  const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = BenchmarkConfigSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid benchmark config' }, { status: 400 });
  }

  // Model-experiment public ids are dedicated preview ids that users must
  // explicitly select; per .specs/model-experiments.md they must never enter
  // kilo-auto candidate sets, so they can't be saved as decider candidates
  // (the routing table feeds kilo-auto/efficient automatic selection). Checked
  // across all experiment statuses — ownership, not just routing membership.
  const deciderModelIds = parsed.data.deciderModels.map(m => m.id);
  const reservedExperimentIds = await findExperimentReservedModelIds(deciderModelIds);
  if (reservedExperimentIds.length > 0) {
    return NextResponse.json(
      {
        error: `Decider models must not be model-experiment public ids (reserved for explicit user selection): ${reservedExperimentIds.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // Routing-table candidates carry no per-protocol metadata, so every decider
  // model must be servable on ALL gateway chat API kinds by the provider the
  // gateway would route it to.
  const unsupported = parsed.data.deciderModels
    .map(m => m.id)
    .filter(id => !modelServesAllGatewayChatApis(id))
    .map(id => `${id} (supports: ${gatewayChatApisForModel(id).join(', ') || 'none'})`);
  if (unsupported.length > 0) {
    return NextResponse.json(
      {
        error: `Decider models must support all gateway chat APIs (chat_completions, responses, messages): ${unsupported.join('; ')}`,
      },
      { status: 400 }
    );
  }

  const email = user?.google_user_email ?? '';
  const result = await updateBenchmarkConfig(parsed.data, email);
  return NextResponse.json(result.body, { status: result.status });
}
