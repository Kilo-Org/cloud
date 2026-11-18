import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Building2 } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { isPersonal } from '@/lib/hooks/use-code-reviewer';
import { type CouncilRefusalReason } from '@/lib/hooks/use-reviewer-council';
import { CREATE_ORGANIZATION_HREF } from '@/lib/organization-navigation';

/**
 * The unavailable sentence each refused scope reads. A personal account never
 * carries council, Bitbucket has no council on either client, and only a
 * settled entitlement refusal names the plan rule; a rollout flag the build
 * cannot apply and a failed entitlement read say nothing about the plan and
 * get the neutral sentence.
 */
function unavailableCopyKey(
  scope: string,
  platformSupportsCouncil: boolean,
  refusalReason: CouncilRefusalReason
): string {
  if (isPersonal(scope)) {
    return 'codeReviewer.council.unavailablePersonally';
  }
  if (!platformSupportsCouncil) {
    return 'codeReviewer.council.unavailableOnBitbucket';
  }
  return refusalReason === 'refused'
    ? 'codeReviewer.council.unavailableForOrganization'
    : 'codeReviewer.council.unavailableForOrganizationNeutral';
}

/** The personal refusal's action: create what the account lacks, or switch. */
function personalActionKey(hasMemberships: boolean): string {
  return hasMemberships
    ? 'codeReviewer.council.unavailablePersonallySwitchAction'
    : 'codeReviewer.council.unavailablePersonallyAction';
}

/**
 * The settled refusal's body: the standard `EmptyState` — a short title above
 * the reason sentence at body size — and, on the personal scope, the one step
 * that changes the answer. A reader with memberships switches to the
 * organization that may unlock council; one without creates the organization
 * whose trial grants it.
 */
export function CouncilRefusalScreen({
  scope,
  platformSupportsCouncil,
  refusalReason,
  membershipState,
}: Readonly<{
  scope: string;
  platformSupportsCouncil: boolean;
  refusalReason: CouncilRefusalReason;
  /** What the account's organization list answers: none, some, or not settled. */
  membershipState: 'none' | 'some' | 'unsettled';
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  const personal = isPersonal(scope);
  const hasMemberships = membershipState === 'some';
  // An unsettled list says nothing about memberships, so its action copy stays
  // neutral: "Create an organization" names a step that exists either way,
  // while "Switch organization" names one only a member can take.
  const actionKey = personalActionKey(hasMemberships);
  return (
    <EmptyState
      icon={Building2}
      title={t(
        personal
          ? 'codeReviewer.council.unavailablePersonallyTitle'
          : 'codeReviewer.council.unavailableOrganizationTitle'
      )}
      description={t(unavailableCopyKey(scope, platformSupportsCouncil, refusalReason))}
      action={
        personal ? (
          <Button
            className={STATE_ACTION_CLASS}
            onPress={() => {
              if (hasMemberships) {
                // The reviewer scope list is the account switcher: every
                // membership on one screen, and a pick there opens the picked
                // account's platform list — where the switch reads.
                router.replace('/(app)/code-reviewer' as Href);
                return;
              }
              router.push(CREATE_ORGANIZATION_HREF);
            }}
            accessibilityLabel={t(actionKey)}
          >
            <Text>{t(actionKey)}</Text>
          </Button>
        ) : undefined
      }
    />
  );
}
