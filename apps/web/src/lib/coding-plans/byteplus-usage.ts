import 'server-only';

import {
  BytePlusControlPlaneError,
  getBytePlusSeatUsage,
  type BytePlusSeatUsage,
} from '@/lib/coding-plans/byteplus-control-plane';
import {
  CodingPlanQuotaWindowsSchema,
  CodingPlanUsageError,
  CodingPlanUsageSnapshotSchema,
  type CodingPlanQuotaWindow,
  type CodingPlanUsageSnapshot,
} from '@/lib/coding-plans/usage-contract';

function resetTimestamp(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  // BytePlus reports reset milestones as Unix timestamps in seconds.
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function bytePlusWindow(input: {
  id: 'short_term' | 'weekly' | 'monthly';
  usage: number | undefined;
  reset: number | undefined;
  period: CodingPlanQuotaWindow['period'];
}): CodingPlanQuotaWindow | null {
  if (input.usage === undefined || !Number.isFinite(input.usage) || input.usage < 0) return null;
  const resetsAt = resetTimestamp(input.reset);
  if (!resetsAt) return null;

  return {
    id: input.id,
    remainingPercent: Math.max(0, 100 - input.usage),
    resetsAt,
    period: input.period,
  };
}

export function normalizeBytePlusUsage(
  usage: BytePlusSeatUsage,
  fetchedAt = new Date().toISOString()
): CodingPlanUsageSnapshot {
  const windows = [
    bytePlusWindow({
      id: 'short_term',
      usage: usage.shortTermUsage,
      reset: usage.shortTermResetMilestone,
      period: { unit: 'hour', value: 5 },
    }),
    bytePlusWindow({
      id: 'weekly',
      usage: usage.weeklyUsage,
      reset: usage.weeklyResetMilestone,
      period: { unit: 'week', value: 1 },
    }),
    bytePlusWindow({
      id: 'monthly',
      usage: usage.monthlyUsage,
      reset: usage.monthlyResetMilestone,
      period: { unit: 'month', value: 1 },
    }),
  ].filter((window): window is CodingPlanQuotaWindow => window !== null);

  const parsed = CodingPlanQuotaWindowsSchema.safeParse(windows);
  if (!parsed.success) {
    throw new CodingPlanUsageError('invalid_response');
  }

  const snapshot = CodingPlanUsageSnapshotSchema.safeParse({ fetchedAt, windows: parsed.data });
  if (!snapshot.success) {
    throw new CodingPlanUsageError('invalid_response');
  }
  return snapshot.data;
}

export async function getBytePlusUsage(seatId: string): Promise<CodingPlanUsageSnapshot> {
  let usage: BytePlusSeatUsage;
  try {
    usage = await getBytePlusSeatUsage(seatId);
  } catch (error) {
    if (error instanceof BytePlusControlPlaneError) {
      throw new CodingPlanUsageError(error.code);
    }
    throw new CodingPlanUsageError('network');
  }

  return normalizeBytePlusUsage(usage);
}

export const getBytePlusCodingPlanUsage = getBytePlusUsage;
export const normalizeBytePlusSeatUsage = normalizeBytePlusUsage;
