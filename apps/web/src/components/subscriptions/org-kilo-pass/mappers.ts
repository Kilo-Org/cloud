import type { inferRouterOutputs } from '@trpc/server';
import { fromMicrodollars } from '@/lib/utils';
import type { RootRouter } from '@/routers/root-router';
import type { OrgKiloPassActivationState } from './OrgKiloPassActivationView';
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
type ActivationResult = RouterOutputs['organizations']['kiloPass']['activation'];
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

export type OrgKiloPassActivationViewModel = {
  state: OrgKiloPassActivationState;
  title: string;
  description: string;
  actionLabel?: string;
  actionTarget?: 'billing_portal' | 'kilo_pass_detail' | 'subscriptions';
  /** Whether the activation page should keep polling for status changes. */
  shouldPoll: boolean;
};

/**
 * Maps the activation query result onto the full activation state machine.
 *
 * Polling continues while activation can still resolve without customer
 * action (awaiting payment, activating, or an automatically retried failure)
 * and stops on action-required states (requires_action, blocked) and terminal
 * states (active, ended).
 */
export function toActivationView(
  result: Pick<
    ActivationResult,
    'state' | 'commercialState' | 'processingCondition' | 'message'
  > | null
): OrgKiloPassActivationViewModel {
  if (result?.commercialState === 'active' || result?.commercialState === 'cancel_at_period_end') {
    return {
      state: 'succeeded',
      title: 'Kilo Pass for Organizations is active',
      description:
        result.message ??
        'Payment is confirmed and your first Credits were added to the organizations you selected.',
      actionLabel: 'View Kilo Pass',
      actionTarget: 'kilo_pass_detail',
      shouldPoll: false,
    };
  }
  if (result?.commercialState === 'ended') {
    return {
      state: 'ended',
      title: 'Kilo Pass for Organizations has ended',
      description:
        result.message ??
        'This agreement has ended. Open subscriptions to review or add Kilo Pass again.',
      actionLabel: 'View subscriptions',
      actionTarget: 'subscriptions',
      shouldPoll: false,
    };
  }
  if (result?.processingCondition === 'suspended_for_review') {
    return {
      state: 'requires_action',
      title: 'Payment needs attention',
      description:
        result.message ??
        'We could not complete your payment. Open billing to confirm your payment method.',
      actionLabel: 'Open billing',
      actionTarget: 'billing_portal',
      shouldPoll: false,
    };
  }
  if (result?.processingCondition === 'blocked') {
    return {
      state: 'blocked',
      title: 'Pass assignments need updating',
      description:
        result.message ??
        'A selected child organization or number of paid seats changed during checkout. Update pass assignments before Credits are added.',
      actionLabel: 'Update pass assignments',
      actionTarget: 'kilo_pass_detail',
      shouldPoll: false,
    };
  }
  if (result?.processingCondition === 'failed') {
    return {
      state: 'failed',
      title: 'Adding your first Credits is delayed',
      description:
        result.message ??
        'Payment is confirmed. Kilo hit a problem adding your first Credits and is trying again automatically.',
      shouldPoll: true,
    };
  }
  if (result?.commercialState === 'pending_payment' || result?.state === 'pending_payment') {
    return {
      state: 'awaiting_payment',
      title: 'Waiting for payment confirmation',
      description:
        result.message ??
        'Checkout is complete. Kilo Pass for Organizations starts after we receive your payment.',
      shouldPoll: true,
    };
  }
  if (!result || result.state === 'unavailable') {
    return {
      state: 'blocked',
      title: 'Checkout could not be confirmed',
      description: 'Return to subscriptions to check your Kilo Pass status.',
      actionLabel: 'View subscriptions',
      actionTarget: 'subscriptions',
      shouldPoll: false,
    };
  }
  return {
    state: 'activating',
    title: 'Adding your first Credits',
    description:
      result.message ?? 'Payment confirmed. We are adding Credits based on your pass assignments.',
    shouldPoll: true,
  };
}
