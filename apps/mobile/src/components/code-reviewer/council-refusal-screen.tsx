import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
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
 * The settled refusal's body: the sentence the scope's reason can claim, and —
 * on the personal scope — the one step that changes the answer. A reader with
 * memberships switches to the organization that may unlock council; one
 * without creates the organization whose trial grants it.
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
  // An unsettled list says nothing about memberships, so its action copy stays
  // neutral: "Create an organization" names a step that exists either way,
  // while "Switch organization" names one only a member can take.
  const actionKey = membershipState === 'some' ? personalActionKey(true) : personalActionKey(false);
  return (
    <CenteredState contentContainerClassName="px-6">
      <View className="items-center gap-3">
        <Text className="text-center text-xs text-muted-foreground">
          {t(unavailableCopyKey(scope, platformSupportsCouncil, refusalReason))}
        </Text>
        {personal ? (
          <Button
            onPress={() => {
              if (membershipState === 'some') {
                // The reviewer scope list is the account switcher: every
                // membership on one screen, and a pick there reopens the
                // picked account's council screen — where the switch reads.
                router.replace('/(app)/code-reviewer' as Href);
                return;
              }
              router.push(CREATE_ORGANIZATION_HREF);
            }}
            accessibilityLabel={t(actionKey)}
          >
            <Text>{t(actionKey)}</Text>
          </Button>
        ) : null}
      </View>
    </CenteredState>
  );
}
