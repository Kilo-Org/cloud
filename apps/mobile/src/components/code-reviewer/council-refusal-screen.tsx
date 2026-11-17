import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { useContextPicker } from '@/components/context-control';
import { useOrganization } from '@/lib/organization-context';
import { Text } from '@/components/ui/text';
import { UNDER_COPY_ACTION_BOX_CLASS, UNDER_COPY_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { isPersonal } from '@/lib/hooks/use-code-reviewer';
import { type CouncilRefusalReason } from '@/lib/hooks/use-reviewer-council';
import { CREATE_ORGANIZATION_HREF } from '@/lib/organization-navigation';
import { useTRPC } from '@/lib/trpc';
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
  membershipState,
  onScopePicked,
}: Readonly<{
  scope: string;
  platformSupportsCouncil: boolean;
  refusalReason: CouncilRefusalReason;
  /** What the account's organization list answers: none, some, or not settled. */
  membershipState: 'none' | 'some' | 'unsettled';
  /**
   * A member's picker pick changes the active account, but the refusal reads
   * the route's scope, so the caller must replace it — otherwise the reader
   * stays on this same refusal, which a pick did not change.
   */
  onScopePicked: (organizationId: string) => void;
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  const trpc = useTRPC();
  const { setOrganizationId } = useOrganization();
  const orgs = useQuery(trpc.organizations.list.queryOptions()).data;
  const { openPicker } = useContextPicker(orgs, organizationId => {
    if (organizationId === null) {
      return;
    }
    // The pick is the new active account everywhere; the route itself is
    // replaced by the caller.
    setOrganizationId(organizationId);
    onScopePicked(organizationId);
  });
  const personal = isPersonal(scope);
  // An unsettled list says nothing about memberships, so its action copy stays
  // neutral: "Create an organization" names a step that exists either way,
  // while "Switch organization" names one only a member can take.
  const actionKey = membershipState === 'some' ? personalActionKey(true) : personalActionKey(false);
  return (
    <CenteredState contentContainerClassName="px-6">
      <View className="items-center gap-2">
        <Text className="text-center text-xs text-muted-foreground">
          {t(unavailableCopyKey(scope, platformSupportsCouncil, refusalReason))}
        </Text>
        {personal ? (
          <Pressable
            onPress={() => {
              if (membershipState === 'some') {
                // The app's established equivalent for a reader with
                // memberships: the shared account picker, not a screen the
                // reader must then find the control on.
                openPicker();
                return;
              }
              router.push(CREATE_ORGANIZATION_HREF);
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
