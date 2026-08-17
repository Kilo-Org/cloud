import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Check } from '@/components/ui/icons';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ROLE_LABEL } from '@/components/organization/member-row';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { captureEvent, ORGANIZATION_MEMBER_INVITED_EVENT } from '@/lib/analytics/posthog';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { isMoneyRole, type OrgRole, useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn, EMAIL_PATTERN } from '@/lib/utils';

const INVITABLE_ROLES: OrgRole[] = ['member', 'billing_manager', 'owner'];
const EMAIL_ERROR = 'Enter a valid email address';

export function InviteMemberSheet() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role: myRole, org, isResolving } = useOrgBoundary();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const emailRef = useRef('');
  const [canSubmit, setCanSubmit] = useState(false);
  const isBillingManager = myRole === 'billing_manager';
  const [role, setRole] = useState<OrgRole>('member');

  if (isResolving) {
    return (
      <ScrollView className="flex-1 bg-background px-6" contentContainerClassName="gap-6 pb-8 pt-4">
        <Skeleton className="h-11 rounded-lg" />
        <Skeleton className="h-11 rounded-lg" />
      </ScrollView>
    );
  }
  if (organizationId == null || org == null) {
    return <OrganizationBoundary />;
  }
  if (!isMoneyRole(myRole)) {
    return <PermissionDenied description="You don't have permission to invite members." />;
  }

  const onSubmit = () => {
    const email = emailRef.current.trim().toLowerCase();
    mutations.invite.mutate(
      { email, role: isBillingManager ? 'member' : role },
      {
        onSuccess: () => {
          captureEvent(ORGANIZATION_MEMBER_INVITED_EVENT, {
            role: isBillingManager ? 'member' : role,
          });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
        },
      }
    );
  };

  return (
    <ScrollView
      className="flex-1 bg-background px-6"
      contentContainerClassName="gap-6 pb-8 pt-4"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-center text-lg font-semibold text-foreground">Invite member</Text>

      <FormField
        label="Email"
        required
        accessibilityLabel="Email"
        placeholder="name@company.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        autoFocus
        validate={value => (EMAIL_PATTERN.test(value.trim()) ? null : EMAIL_ERROR)}
        onChangeText={value => {
          emailRef.current = value;
          setCanSubmit(EMAIL_PATTERN.test(value.trim()));
        }}
      />

      {isBillingManager ? (
        <Text variant="muted">Role: Member</Text>
      ) : (
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Role
          </Text>
          <RadioGroup label="Role" className="overflow-hidden rounded-lg bg-secondary">
            {INVITABLE_ROLES.map((value, index) => {
              const selected = role === value;
              return (
                <Pressable
                  key={value}
                  className={cn(
                    'min-h-11 flex-row items-center justify-between px-4 py-3 active:opacity-70',
                    index < INVITABLE_ROLES.length - 1 && 'border-b-[0.5px] border-hair-soft'
                  )}
                  onPress={() => {
                    setRole(value);
                  }}
                  {...radioItemA11y({ label: ROLE_LABEL[value], checked: selected })}
                >
                  <Text className="flex-1 text-sm">{ROLE_LABEL[value]}</Text>
                  {selected && <Check size={16} color={colors.primary} />}
                </Pressable>
              );
            })}
          </RadioGroup>
        </View>
      )}

      {/* The mutation hook has no toast for invite (inline error pattern P2),
          so AccessibleStatus is the single announcement owner here: one
          announcement per platform, visuals preserved (tone error). */}
      <AccessibleStatus
        message={mutations.invite.isError ? mutations.invite.error.message : null}
        className="text-sm"
      />

      {/* Disabled-until-valid (D11): the button cannot fire while the email is
          invalid, so focus-to-first-invalid has no reachable submit boundary. */}
      <Button disabled={!canSubmit} loading={mutations.invite.isPending} onPress={onSubmit}>
        <Text className="text-primary-foreground">Send invite</Text>
      </Button>
    </ScrollView>
  );
}
