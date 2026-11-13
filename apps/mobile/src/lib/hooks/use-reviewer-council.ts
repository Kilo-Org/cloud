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
 * The council config gate, identical to the web page's: an entitled
 * organization behind the rollout flag. A personal scope can never show it, and
 * neither can a build that predates the flag (its registry minimum applies in
 * `useFeatureFlag`).
 *
 * `pending` separates "the entitlement read is still in flight" from "this
 * organization is not entitled": only the latter may tell a reader the surface
 * is unavailable, or an entitled org would read that on every cold open.
 */
export function useCouncilGate(scope: string) {
  const flagEnabled = useFeatureFlag(CODE_REVIEW_COUNCIL_FLAG);
  const qualified = flagEnabled && !isPersonal(scope);
  const entitlement = useCouncilEntitlement(scope, flagEnabled);
  return {
    allowed: qualified && (entitlement.data?.entitled ?? false),
    pending: qualified && entitlement.isPending,
  };
}

/** Boolean view of the same gate, for surfaces that only show or hide an entry. */
export function useCouncilUiEnabled(scope: string): boolean {
  return useCouncilGate(scope).allowed;
}
