import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  type ActiveOrgMember,
  useOrgRole,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { firstNonEmpty } from '@/lib/utils';

const MAX_DAILY_LIMIT_USD = 2000;

function parseLimit(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_DAILY_LIMIT_USD) {
    return null;
  }
  return parsed;
}

function isValidLimit(value: string): boolean {
  return parseLimit(value) != null;
}

type MemberLimitFormProps = Readonly<{
  memberId: string;
  organizationId: string | null;
  member: ActiveOrgMember;
}>;

function MemberLimitForm({ memberId, organizationId, member }: MemberLimitFormProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const currentLimit = member.dailyUsageLimitUsd;

  const limitRef = useRef(currentLimit != null ? String(currentLimit) : '');
  const [canSave, setCanSave] = useState(isValidLimit(limitRef.current));

  const onSaved = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const onSave = () => {
    const parsed = parseLimit(limitRef.current);
    if (parsed == null) {
      return;
    }
    mutations.updateMember.mutate({ memberId, dailyUsageLimitUsd: parsed }, { onSuccess: onSaved });
  };

  const onRemove = () => {
    mutations.updateMember.mutate({ memberId, dailyUsageLimitUsd: null }, { onSuccess: onSaved });
  };

  return (
    <>
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          Limit (USD per day)
        </Text>
        <TextInput
          accessibilityLabel="Daily usage limit"
          className="h-11 rounded-lg bg-secondary px-3 text-sm leading-5 text-foreground"
          placeholder="No limit"
          placeholderTextColor={colors.mutedForeground}
          keyboardType="decimal-pad"
          defaultValue={currentLimit != null ? String(currentLimit) : undefined}
          onChangeText={value => {
            limitRef.current = value;
            setCanSave(isValidLimit(value));
          }}
        />
      </View>

      {mutations.updateMember.isError && (
        <Text className="text-sm text-destructive">{mutations.updateMember.error.message}</Text>
      )}

      <Button disabled={!canSave || mutations.updateMember.isPending} onPress={onSave}>
        {mutations.updateMember.isPending ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : null}
        <Text className="text-primary-foreground">Save</Text>
      </Button>

      {currentLimit != null && (
        <Button
          variant="destructive"
          disabled={mutations.updateMember.isPending}
          onPress={onRemove}
        >
          <Text className="text-destructive-foreground">Remove limit</Text>
        </Button>
      )}
    </>
  );
}

export function MemberLimitSheet({ memberId }: Readonly<{ memberId: string }>) {
  const { organizationId } = useOrgRole();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const member = orgWithMembers.data?.members.find(
    (m): m is ActiveOrgMember => m.status === 'active' && m.id === memberId
  );

  if (orgWithMembers.isLoading) {
    return (
      <ScrollView className="flex-1 bg-background px-6" contentContainerClassName="gap-6 pb-8 pt-4">
        <View className="gap-1">
          <Text className="text-center text-lg font-semibold text-foreground">
            Daily usage limit
          </Text>
        </View>
        <Skeleton className="h-11 rounded-lg" />
      </ScrollView>
    );
  }

  if (!member) {
    return (
      <ScrollView className="flex-1 bg-background px-6" contentContainerClassName="gap-6 pb-8 pt-4">
        <Text className="text-center text-lg font-semibold text-foreground">Daily usage limit</Text>
        <Text className="text-center text-sm text-muted-foreground">Member not found</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background px-6"
      contentContainerClassName="gap-6 pb-8 pt-4"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-1">
        <Text className="text-center text-lg font-semibold text-foreground">Daily usage limit</Text>
        <Text className="text-center text-sm text-muted-foreground" numberOfLines={1}>
          {firstNonEmpty(member.name, member.email)}
        </Text>
      </View>

      <MemberLimitForm memberId={memberId} organizationId={organizationId} member={member} />
    </ScrollView>
  );
}
