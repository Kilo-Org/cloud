import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { Text } from '@/components/ui/text';
import { UNDER_COPY_ACTION_BOX_CLASS, UNDER_COPY_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { isPersonal } from '@/lib/hooks/use-code-reviewer';
import { type CouncilRefusalReason } from '@/lib/hooks/use-reviewer-council';
import { CREATE_ORGANIZATION_HREF } from '@/lib/organization-navigation';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { cn } from '@/lib/utils';

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
  hasMemberships,
}: Readonly<{
  scope: string;
  platformSupportsCouncil: boolean;
  refusalReason: CouncilRefusalReason;
  hasMemberships: boolean;
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  const personal = isPersonal(scope);
  const actionKey = personalActionKey(hasMemberships);
  return (
    <CenteredState contentContainerClassName="px-6">
      <View className="items-center gap-2">
        <Text className="text-center text-xs text-muted-foreground">
          {t(unavailableCopyKey(scope, platformSupportsCouncil, refusalReason))}
        </Text>
        {personal ? (
          <Pressable
            onPress={() => {
              router.push(hasMemberships ? PROFILE_TAB_HREF : CREATE_ORGANIZATION_HREF);
            }}
            accessibilityRole="button"
            accessibilityLabel={t(actionKey)}
            hitSlop={UNDER_COPY_ACTION_HIT_SLOP}
            className={cn(
              'justify-center self-center rounded-md active:opacity-70',
              UNDER_COPY_ACTION_BOX_CLASS
            )}
          >
            <Text className="text-xs font-semibold text-muted-foreground underline">
              {t(actionKey)}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </CenteredState>
  );
}

// Keep the tree-shaken default export the route's lazy loader expects.
export default CouncilRefusalScreen;
