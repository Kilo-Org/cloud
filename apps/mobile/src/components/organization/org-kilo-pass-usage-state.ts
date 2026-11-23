import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { readTrpcErrorField } from '@/lib/trpc-error';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** One issued work window of the organization's Kilo Pass. */
export type OrgKiloPassUsageOutput = NonNullable<
  RouterOutputs['organizations']['kiloPass']['usage']
>;
export type OrgKiloPassUsageAllocation = OrgKiloPassUsageOutput['currentAllocations'][number];

/**
 * The section's phase, as one union rather than a set of flags beside it.
 *
 * `hidden` covers "this reader may not see it", "this organization has no Kilo
 * Pass at all" and "its agreement has ended". The usage read answers `null` for
 * all three, so the summary separates them: it knows whether an agreement exists
 * and whether that agreement still has a current period to describe. An ended
 * agreement has none, and the web card renders nothing for it, so neither does
 * this section.
 */
export type OrgKiloPassUsageState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'retryable' }
  | { kind: 'empty' }
  | {
      kind: 'ready';
      allocations: readonly OrgKiloPassUsageAllocation[];
      fullMonthlyCreditsPerPassUsd: number;
    };

/** Codes that name a state asking again cannot change, so no Retry is offered. */
const TERMINAL_USAGE_CODES = new Set(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND']);

/**
 * Which phase the section is in, from the read and the two gates the caller
 * already resolved. Pure so every branch can be pinned without mounting.
 *
 * The phases are decided in this order: the gates first, because a read that
 * never ran has nothing to say; then the load, so a first answer does not flash
 * an empty sentence; then the failure, split by whether asking again could
 * help; and only then the payload, where `null` and an empty allocation list
 * both mean "no window issued yet".
 */
export function getOrgKiloPassUsageState(input: {
  agreementOpen: boolean;
  hasBillingRole: boolean;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: OrgKiloPassUsageOutput | null | undefined;
}): OrgKiloPassUsageState {
  if (!input.hasBillingRole || !input.agreementOpen) {
    return { kind: 'hidden' };
  }
  if (input.isPending) {
    return { kind: 'loading' };
  }
  if (input.isError) {
    const code = readTrpcErrorField(input.error, 'code');
    return code !== undefined && TERMINAL_USAGE_CODES.has(code)
      ? { kind: 'unavailable' }
      : { kind: 'retryable' };
  }
  // The server answers `null` rather than an empty list today; a payload with no
  // allocation has no rows to draw either way.
  if (input.data == null || input.data.currentAllocations.length === 0) {
    return { kind: 'empty' };
  }
  return {
    kind: 'ready',
    allocations: input.data.currentAllocations,
    fullMonthlyCreditsPerPassUsd: input.data.terms.baseCreditsPerPassUsd,
  };
}
