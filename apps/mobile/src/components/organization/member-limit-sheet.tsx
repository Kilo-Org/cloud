import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { limitError, parseLimit } from '@/components/organization/member-limit-validators';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  type ActiveOrgMember,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { firstNonEmpty } from '@/lib/utils';

type MemberLimitFormProps = Readonly<{
  memberId: string;
  organizationId: string | null;
  member: ActiveOrgMember;
}>;

function MemberLimitForm({ memberId, organizationId, member }: MemberLimitFormProps) {
  const router = useRouter();
  const mutations = useOrganizationMutations(organizationId ?? '', {
    silenceUpdateMemberToast: true,
  });
  const currentLimit = member.dailyUsageLimitUsd;

  const limitRef = useRef(currentLimit != null ? String(currentLimit) : '');
  const [canSave, setCanSave] = useState(limitError(limitRef.current) == null);

  const onSaved = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const onSave = () => {
    if (!canSave) {
      return;
    }
    const parsed = parseLimit(limitRef.current);
    mutations.updateMember.mutate({ memberId, dailyUsageLimitUsd: parsed }, { onSuccess: onSaved });
  };

  const onRemove = () => {
    mutations.updateMember.mutate({ memberId, dailyUsageLimitUsd: null }, { onSuccess: onSaved });
  };

  return (
    <>
      <FormField
        label="Limit (USD per day)"
        accessibilityLabel="Daily usage limit"
        placeholder="No limit"
        keyboardType="decimal-pad"
        defaultValue={currentLimit != null ? String(currentLimit) : undefined}
        validate={limitError}
        onChangeText={value => {
          limitRef.current = value;
          setCanSave(limitError(value) == null);
        }}
      />

      {mutations.updateMember.isError && (
        <Text className="text-sm text-destructive">{mutations.updateMember.error.message}</Text>
      )}

      <Button disabled={!canSave} loading={mutations.updateMember.isPending} onPress={onSave}>
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
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const member = orgWithMembers.data?.members.find(
    (m): m is ActiveOrgMember => m.status === 'active' && m.id === memberId
  );

  if (isResolving || orgWithMembers.isLoading) {
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

  if (organizationId == null || org == null) {
    return <OrganizationBoundary />;
  }

  if (role !== 'owner') {
    return <PermissionDenied description="Only the organization owner can manage usage limits." />;
  }

  if (orgWithMembers.isError && !orgWithMembers.data) {
    return (
      <ScrollView className="flex-1 bg-background px-6" contentContainerClassName="gap-6 pb-8 pt-4">
        <Text className="text-center text-lg font-semibold text-foreground">Daily usage limit</Text>
        <QueryError
          onRetry={() => void orgWithMembers.refetch()}
          isRetrying={orgWithMembers.isFetching}
          placement="top"
        />
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
