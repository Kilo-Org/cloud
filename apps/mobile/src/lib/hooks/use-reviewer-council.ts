import {
  COUNCIL_SPECIALIST_PRESETS,
  DEFAULT_COUNCIL_AGGREGATION_STRATEGY,
} from '@kilocode/app-shared/code-review';
import { CODE_REVIEW_COUNCIL_FLAG } from '@kilocode/app-shared/feature-flags';
import { useQuery } from '@tanstack/react-query';

import { useFeatureFlag } from '@/lib/analytics/posthog';
import { type CouncilConfig } from '@/lib/code-reviewer-config';
import { isPersonal } from '@/lib/hooks/use-code-reviewer';
import { useTRPC } from '@/lib/trpc';

/**
 * The council config a first visit edits: every preset enabled on the default
 * governance mode, which is the web form's initial picker state. It is a draft,
 * not an activation: the switch starts off because no council is stored, and
 * the draft's `enabled` follows that until the user turns it on.
 */
export function defaultCouncilConfig(): CouncilConfig {
  return {
    enabled: false,
    aggregation_strategy: DEFAULT_COUNCIL_AGGREGATION_STRATEGY,
    specialists: COUNCIL_SPECIALIST_PRESETS.map(preset => ({
      id: preset.id,
      role: preset.role,
      name: preset.name,
      enabled: true,
      required: false,
      lens: preset.lens,
    })),
  };
}

/** How many specialists would actually vote under this config. */
export function enabledSpecialistCount(council: CouncilConfig): number {
  return council.specialists.filter(specialist => specialist.enabled).length;
}

function useCouncilEntitlement(scope: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.organizations.reviewAgent.getCouncilEntitlement.queryOptions({
      organizationId: scope,
    }),
    // Entitlement is a database read the web page also skips unless the flag is
    // on, and it only exists for organizations (council is org-only).
    enabled: enabled && !isPersonal(scope),
  });
}

/**
 * Why a settled organization refusal reads refused. Only a settled entitlement
 * answer may name the plan rule, so the other two keep to what the reader can
 * actually do: a rollout flag the build cannot apply is an app update, and a
 * failed entitlement read is a retry that checks the plan again.
 */
export type CouncilRefusalReason = 'flagUnavailable' | 'entitlementErrored' | 'refused';

/** What the council gate answers a screen: the decision and the refusal's own state. */
export type CouncilGate = {
  /** The organization is entitled, behind the rollout flag: the editor may paint. */
  allowed: boolean;
  /** The first entitlement read has not settled, so the surface stays blank. */
  pending: boolean;
  /** The settled refusal, or null while the gate still allows the editor. */
  refusalReason: CouncilRefusalReason | null;
  /** Re-runs the one entitlement read the failed-check refusal offers. */
  retryEntitlement: () => void;
  /** That read is in flight, so its Retry reports its own wait. */
  entitlementFetching: boolean;
};

/**
 * The council config gate, identical to the web page's: an entitled
 * organization behind the rollout flag. A personal scope can never show it, and
 * neither can a build that predates the flag (its registry minimum applies in
 * `useFeatureFlag`).
 *
 * `pending` separates "the entitlement read has never settled" from "this
 * organization is not entitled": only a first read may hold the surface blank,
 * or an entitled org would read "unavailable" on every cold open. A re-read
 * started by the refusal's own Retry must not turn back into that blank
 * surface, and the query cannot be asked directly: re-running with no answer
 * yet clears its own error and reports `pending` again, which is exactly what a
 * first read reports. So the gate asks whether the read ever landed an outcome
 * (`isFetched`), which survives the re-read, and that one answer decides all
 * three of the blank surface, the failed-check refusal and the plan refusal.
 * `retryEntitlement` re-runs that one read, which is the whole step the
 * `entitlementErrored` refusal offers, and `entitlementFetching` is the same
 * read's busy state, so the retry reports its own wait instead of vanishing.
 */
export function useCouncilGate(scope: string): CouncilGate {
  const flagEnabled = useFeatureFlag(CODE_REVIEW_COUNCIL_FLAG);
  const qualified = flagEnabled && !isPersonal(scope);
  const entitlement = useCouncilEntitlement(scope, flagEnabled);
  // A query that re-runs with no answer yet clears its own error and reports
  // `pending` again, so neither `isError` nor `isPending` says whether this read
  // ever settled. `isFetched` counts the answers it has landed and survives the
  // re-read, which is what separates a first read from the refusal's own Retry.
  const settled = entitlement.isFetched;
  const answer = entitlement.data;
  let refusalReason: CouncilRefusalReason | null = null;
  if (!qualified) {
    refusalReason = 'flagUnavailable';
  } else if (settled && answer === undefined) {
    // Settled without an answer: the plan check itself failed.
    refusalReason = 'entitlementErrored';
  } else if (answer !== undefined && !answer.entitled) {
    refusalReason = 'refused';
  }
  return {
    allowed: qualified && (answer?.entitled ?? false),
    // Only a read that has never answered holds the surface blank, so the
    // refusal and its busy Retry stay painted while that Retry runs.
    pending: qualified && !settled,
    refusalReason,
    retryEntitlement: () => void entitlement.refetch(),
    entitlementFetching: entitlement.isFetching,
  };
}

/**
 * Whether this build can offer the council entry on this scope at all: the
 * rollout flag the build applies, on an organization. The overview row is
 * offered before the plan check answers, because the council route's refusal
 * screen is the only place that explains a refusal; reading the entitlement
 * here would hide the row from an organization the reader could be told how to
 * upgrade, and would run that read twice once the route mounts. The entitlement
 * stays with `useCouncilGate`, which the route owns.
 */
export function useCouncilEntryAvailable(scope: string): boolean {
  const flagEnabled = useFeatureFlag(CODE_REVIEW_COUNCIL_FLAG);
  return flagEnabled && !isPersonal(scope);
}
