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

function parseCostBound(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function GET(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const minCostUsd = parseCostBound(
    req.nextUrl.searchParams.get('minCostUsd'),
    AUTO_DECIDER_MIN_COST_USD
  );
  const maxCostUsd = parseCostBound(
    req.nextUrl.searchParams.get('maxCostUsd'),
    AUTO_DECIDER_MAX_COST_USD
  );
  if (minCostUsd > maxCostUsd) {
    return NextResponse.json({ error: 'Invalid cost bounds' }, { status: 400 });
  }

  const candidates = await listAutoRoutingDeciderCandidates({ minCostUsd, maxCostUsd });
  return NextResponse.json({
    candidates,
    minCostUsd,
    maxCostUsd,
    generatedAt: new Date().toISOString(),
  });
}
