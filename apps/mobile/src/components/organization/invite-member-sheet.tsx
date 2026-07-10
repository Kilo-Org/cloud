import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { ROLE_LABEL } from '@/components/organization/member-row';
import { captureEvent, ORGANIZATION_MEMBER_INVITED_EVENT } from '@/lib/analytics/posthog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type OrgRole, useOrgRole } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn, EMAIL_PATTERN } from '@/lib/utils';

const INVITABLE_ROLES: OrgRole[] = ['member', 'billing_manager', 'owner'];

export function InviteMemberSheet() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role: myRole } = useOrgRole();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const emailRef = useRef('');
  const [canSubmit, setCanSubmit] = useState(false);
  const isBillingManager = myRole === 'billing_manager';
  const [role, setRole] = useState<OrgRole>('member');

  const onSubmit = () => {
    const email = emailRef.current.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      return;
    }
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

      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          Email
        </Text>
        <TextInput
          accessibilityLabel="Email"
          className="h-11 rounded-lg bg-secondary px-3 text-sm leading-5 text-foreground"
          placeholder="name@company.com"
          placeholderTextColor={colors.mutedForeground}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onChangeText={value => {
            emailRef.current = value;
            setCanSubmit(EMAIL_PATTERN.test(value.trim()));
          }}
        />
      </View>

      {isBillingManager ? (
        <Text variant="muted">Role: Member</Text>
      ) : (
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Role
          </Text>
          <View className="overflow-hidden rounded-lg bg-secondary">
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
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Text className="flex-1 text-sm">{ROLE_LABEL[value]}</Text>
                  {selected && <Check size={16} color={colors.primary} />}
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {mutations.invite.isError && (
        <Text className="text-sm text-destructive">{mutations.invite.error.message}</Text>
      )}

      <Button disabled={!canSubmit || mutations.invite.isPending} onPress={onSubmit}>
        {mutations.invite.isPending ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : null}
        <Text className="text-primary-foreground">Send invite</Text>
      </Button>
    </ScrollView>
  );
}
