import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type OrgGroupMemberPickerState } from '@/components/organization/org-group-form-model';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { QueryError } from '@/components/query-error';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type ActiveOrgMember } from '@/lib/hooks/use-organization-queries';
import { cn } from '@/lib/utils';

type GroupMemberPickerProps = Readonly<{
  /** The picker's phase: a pending or failed fetch never reads as an empty search. */
  picker: OrgGroupMemberPickerState;
  /** The failed query, mapped to a retryable or terminal view only in the error phase. */
  error: unknown;
  isRetrying: boolean;
  onRetry: () => void;
  /** The members the search leaves visible, in the order the server sent them. */
  visibleMembers: readonly ActiveOrgMember[];
  memberIds: readonly string[];
  allVisibleSelected: boolean;
  busy: boolean;
  onToggleAll: (selected: boolean) => void;
  onToggleMember: (memberId: string, selected: boolean) => void;
}>;

/**
 * The group's member selection. Its own loading, failure and empty states keep a
 * pending or failed members query from claiming there is no member to pick.
 */
export function GroupMemberPicker({
  picker,
  error,
  isRetrying,
  onRetry,
  visibleMembers,
  memberIds,
  allVisibleSelected,
  busy,
  onToggleAll,
  onToggleMember,
}: GroupMemberPickerProps) {
  const { t } = useTranslation();

  if (picker.kind === 'loading') {
    return (
      <View className="gap-2 rounded-lg bg-secondary p-4">
        <Skeleton className="h-4 w-40 rounded" />
        <Skeleton className="h-4 w-56 rounded" />
        <Skeleton className="h-4 w-48 rounded" />
      </View>
    );
  }
  if (picker.kind === 'error') {
    const errorView = selectOrgListErrorView(error);
    return (
      <QueryError
        variant={errorView.variant}
        placement="static"
        onRetry={errorView.showRetry ? onRetry : undefined}
        isRetrying={isRetrying}
      />
    );
  }
  if (picker.kind === 'empty') {
    return (
      <Text variant="muted" className="text-sm">
        {t('organization.groups.membersEmpty')}
      </Text>
    );
  }
  return (
    <View className="overflow-hidden rounded-lg bg-secondary">
      <ChoiceRow
        label={t('organization.groups.selectAllVisible')}
        selected={allVisibleSelected}
        multi
        disabled={busy}
        onPress={() => {
          onToggleAll(!allVisibleSelected);
        }}
        className={cn('border-b-[0.5px] border-hair-soft')}
      />
      {visibleMembers.map((member, index) => (
        <ChoiceRow
          key={member.id}
          label={member.name}
          description={member.email}
          selected={memberIds.includes(member.id)}
          multi
          disabled={busy}
          onPress={() => {
            onToggleMember(member.id, !memberIds.includes(member.id));
          }}
          className={cn(index < visibleMembers.length - 1 && 'border-b-[0.5px] border-hair-soft')}
        />
      ))}
    </View>
  );
}
