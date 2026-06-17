import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import {
  AUTO_DECIDER_MAX_COST_USD,
  AUTO_DECIDER_MIN_COST_USD,
  listAutoRoutingDeciderCandidates,
} from '@/lib/model-stats/auto-routing-decider-candidates';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return trimmed.slice(7).trim() || null;
}

export async function GET(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const candidates = await listAutoRoutingDeciderCandidates();
  return NextResponse.json({
    candidates,
    minCostUsd: AUTO_DECIDER_MIN_COST_USD,
    maxCostUsd: AUTO_DECIDER_MAX_COST_USD,
    generatedAt: new Date().toISOString(),
  });
}
