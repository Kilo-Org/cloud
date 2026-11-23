import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';
import { DirectionalArrowRight } from '@/components/ui/directional-icons';
import { Building2, CreditCard, Plus, RotateCcw } from '@/components/ui/icons';
import { isPersonal } from '@/lib/hooks/use-code-reviewer';
import { type CouncilRefusalReason } from '@/lib/hooks/use-reviewer-council';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { CREATE_ORGANIZATION_HREF } from '@/lib/organization-navigation';
import { billingHrefFor, useCanManageBilling } from '@/lib/trial-refusal';

/**
 * The organization sentence for each reason that leaves the reader with no
 * step of their own. Keyed by the reason so a fourth reason cannot reach the
 * screen without a sentence: `satisfies` stops compiling.
 */
const ORGANIZATION_UNAVAILABLE_COPY_KEYS = {
  entitlementErrored: 'codeReviewer.council.unavailablePlanCheck',
  flagUnavailable: 'codeReviewer.council.unavailableFlagRollout',
} as const satisfies Record<Exclude<CouncilRefusalReason, 'refused'>, string>;

/**
 * The unavailable sentence each refused scope reads. A personal account never
 * carries council, Bitbucket has no council on either client, and the three
 * organization reasons each name what the reader can do about them: a failed
 * plan check is a retry, a rollout flag the build cannot apply is an app
 * update, and only a settled entitlement refusal names the plan rule — to the
 * role that can change it, or to the owner who can.
 */
function unavailableCopyKey({
  scope,
  platformSupportsCouncil,
  refusalReason,
  canManageBilling,
}: Readonly<{
  scope: string;
  platformSupportsCouncil: boolean;
  refusalReason: CouncilRefusalReason;
  canManageBilling: boolean;
}>): string {
  if (isPersonal(scope)) {
    return 'codeReviewer.council.unavailablePersonally';
  }
  if (!platformSupportsCouncil) {
    return 'codeReviewer.council.unavailableOnBitbucket';
  }
  if (refusalReason === 'refused') {
    return canManageBilling
      ? 'codeReviewer.council.unavailableForOrganization'
      : 'codeReviewer.council.unavailableForOrganizationMember';
  }
  return ORGANIZATION_UNAVAILABLE_COPY_KEYS[refusalReason];
}

/** The personal refusal's action: create what the account lacks, or switch. */
function personalActionKey(hasMemberships: boolean): string {
  return hasMemberships
    ? 'codeReviewer.council.unavailablePersonallySwitchAction'
    : 'codeReviewer.council.unavailablePersonallyAction';
}

/**
 * The settled refusal's body: the standard `EmptyState` — a short title above
 * the reason sentence at body size — and the one step that changes the answer,
 * where one exists. A personal reader switches to the organization that may
 * unlock council, or creates the organization whose trial grants it; an
 * organization reader retries a plan check that failed, and a role that can
 * change the plan opens billing (everyone else reads the copy naming the
 * owner). A rollout flag the build cannot apply has no step in the app.
 */
export function CouncilRefusalScreen({
  scope,
  platformSupportsCouncil,
  refusalReason,
  membershipState,
  retryEntitlement,
  entitlementFetching,
}: Readonly<{
  scope: string;
  platformSupportsCouncil: boolean;
  refusalReason: CouncilRefusalReason;
  /** What the account's organization list answers: none, some, or not settled. */
  membershipState: 'none' | 'some' | 'unsettled';
  /** Re-runs the entitlement read the failed plan check comes from. */
  retryEntitlement: () => void;
  /** Whether that read is in flight, so the retry reports its own wait. */
  entitlementFetching: boolean;
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  const stackSafeRouter = useStackSafeReplace();
  const personal = isPersonal(scope);
  // The billing role comes from the shared membership list, the one read every
  // converted refusal uses; it reads as a member until that list settles, so a
  // refusal painted early keeps the owner-naming copy.
  const canManageBilling = useCanManageBilling(scope);
  const hasMemberships = membershipState === 'some';
  // An unsettled list says nothing about memberships, so its action copy stays
  // neutral: "Create an organization" names a step that exists either way,
  // while "Switch organization" names one only a member can take.
  const actionKey = personalActionKey(hasMemberships);

  const renderOrgAction = () => {
    if (!platformSupportsCouncil) {
      return undefined;
    }
    if (refusalReason === 'entitlementErrored') {
      return (
        <StateAction
          icon={RotateCcw}
          label={t('common.retry')}
          loading={entitlementFetching}
          onPress={retryEntitlement}
        />
      );
    }
    if (refusalReason === 'refused' && canManageBilling) {
      return (
        <StateAction
          icon={CreditCard}
          label={t('organization.hub.manageBilling')}
          onPress={() => {
            router.push(billingHrefFor(scope));
          }}
        />
      );
    }
    return undefined;
  };

  return (
    <EmptyState
      icon={Building2}
      title={t(
        personal
          ? 'codeReviewer.council.unavailablePersonallyTitle'
          : 'codeReviewer.council.unavailableOrganizationTitle'
      )}
      description={t(
        unavailableCopyKey({
          scope,
          platformSupportsCouncil,
          refusalReason,
          canManageBilling,
        })
      )}
      action={
        personal ? (
          <StateAction
            label={t(actionKey)}
            icon={hasMemberships ? DirectionalArrowRight : Plus}
            onPress={() => {
              if (hasMemberships) {
                // The reviewer scope list is the account switcher: every
                // membership on one screen, and a pick there opens the picked
                // account's platform list — where the switch reads.
                // Swapping the refusal for the scope list in one commit crashes
                // Android Fabric, so it pushes then retires.
                stackSafeRouter.replace('/(app)/code-reviewer' as Href);
                return;
              }
              router.push(CREATE_ORGANIZATION_HREF);
            }}
          />
        ) : (
          renderOrgAction()
        )
      }
    />
  );
}
