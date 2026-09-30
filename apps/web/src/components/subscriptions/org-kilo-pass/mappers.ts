import type { inferRouterOutputs } from '@trpc/server';
import { fromMicrodollars } from '@/lib/utils';
import type { RootRouter } from '@/routers/root-router';
import type {
  OrgKiloPassAllocation,
  OrgKiloPassCadence,
  OrgKiloPassCondition,
  OrgKiloPassTerms,
  OrgKiloPassTier,
} from './types';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type ProcessingCondition =
  RouterOutputs['organizations']['kiloPass']['summary']['processingCondition'];
type CurrentAllocationResult =
  RouterOutputs['organizations']['kiloPass']['detail']['currentAllocations'][number];

export function toCondition(condition: ProcessingCondition): OrgKiloPassCondition | undefined {
  if (condition === 'manual') {
    return {
      kind: 'manual',
      title: 'Pass processing needs attention',
      description: 'Kilo is reviewing the next Credit period. Current Credits are unaffected.',
    };
  }
  if (condition === 'overallocated') {
    return {
      kind: 'overallocated',
      title: 'Pass assignments exceed available passes',
      description: 'Update the next pass assignments before the next Credit period can begin.',
    };
  }
  if (condition === 'blocked') {
    return {
      kind: 'blocked',
      title: 'Pass processing is blocked',
      description: 'Review the next pass assignments before the next Credit period can begin.',
    };
  }
  if (condition === 'failed') {
    return {
      kind: 'failed',
      title: 'Credit processing is delayed',
      description: 'Kilo is retrying automatically. No action is needed right now.',
    };
  }
  if (condition === 'suspended_for_review') {
    return {
      kind: 'payment_review',
      title: 'Payment needs attention',
      description: 'Complete the payment step to activate Kilo Pass for Organizations.',
    };
  }
  return undefined;
}

/**
 * Maps a current-period allocation from microdollars onto the USD amounts the
 * allocation views render.
 */
export function toCurrentAllocation(allocation: CurrentAllocationResult): OrgKiloPassAllocation {
  return {
    organizationId: allocation.organizationId,
    organizationName: allocation.organizationName,
    kind: allocation.kind,
    passCount: allocation.passCount,
    hasProratedCredits: allocation.hasProratedCredits,
    baseCreditsUsd: fromMicrodollars(allocation.baseCreditsMicrodollars),
    qualifyingSpendUsd: fromMicrodollars(allocation.qualifyingSpendMicrodollars),
    unlockTargetUsd: fromMicrodollars(allocation.unlockTargetMicrodollars),
    bonusCreditsUsd: fromMicrodollars(allocation.bonusCreditsMicrodollars),
    bonusState: allocation.bonusState,
  };
}

export function toCurrentAllocations(
  allocations: CurrentAllocationResult[]
): OrgKiloPassAllocation[] {
  return allocations.map(toCurrentAllocation);
}

/**
 * Resolves the display terms for one tier. Prefers the versioned `terms`
 * payload the summary, setup, and detail API outputs carry.
 */
export function toOrgKiloPassTerms(source: {
  tier: OrgKiloPassTier;
  terms: OrgKiloPassTerms;
}): OrgKiloPassTerms {
  return source.terms;
}

/** Resolves the selectable terms for setup from the API's `terms` array. */
export function toSetupTerms(setup: {
  paidSeatCount: number;
  terms: OrgKiloPassTerms[];
}): OrgKiloPassTerms[] {
  return setup.terms;
}

/**
 * Resolves the detail view's display terms and cadence. Reads the versioned
 * `terms` and `cadence` fields the detail API output carries.
 */
export function toDetailPresentation(detail: {
  tier: OrgKiloPassTier;
  terms: OrgKiloPassTerms;
  cadence: 'monthly' | 'yearly';
}): { terms: OrgKiloPassTerms; cadence: OrgKiloPassCadence } {
  return {
    terms: toOrgKiloPassTerms(detail),
    cadence: detail.cadence === 'yearly' ? 'annual' : 'monthly',
  };
}

export function toSetupAllocations(
  organizationId: string,
  organizationName: string,
  children: { id: string; name: string }[]
): OrgKiloPassAllocation[] {
  return [
    { organizationId, organizationName, kind: 'parent', passCount: 0 },
    ...children.map(child => ({
      organizationId: child.id,
      organizationName: child.name,
      kind: 'child' as const,
      passCount: 0,
    })),
  ];
}
