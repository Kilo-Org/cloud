import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type OrgGroupMemberPickerState } from '@/components/organization/org-group-form-model';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { QueryError } from '@/components/query-error';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { type ActiveOrgMember } from '@/lib/hooks/use-organization-queries';

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
      <RowGroup>
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </RowGroup>
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
      <Text variant="muted">{t('organization.groups.membersEmpty')}</Text>
    );
  }
  return (
    <RowGroup>
      <ChoiceRow
        label={t('organization.groups.selectAllVisible')}
        selected={allVisibleSelected}
        multi
        disabled={busy}
        onPress={() => {
          onToggleAll(!allVisibleSelected);
        }}
      />
      {visibleMembers.map(member => (
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
        />
      ))}
    </RowGroup>
  );
}
