import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { EmptyState, StateAction } from '@/components/empty-state';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Plus, SlidersHorizontal } from '@/components/ui/icons';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { type AgentProfileListItem } from '@/lib/hooks/use-agent-profiles';

type ProfilePickerSheetProps = Readonly<{
  profiles: readonly AgentProfileListItem[];
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  selectedProfileId: string;
  /** The empty state's explanation, worded for the context the list reads. */
  emptyDescription: string;
  /**
   * Opens the profile create screen. Absent when this context cannot create a
   * profile, so the empty state never points at an action it does not offer.
   */
  onCreateProfile?: (() => void) | undefined;
  onRetry: () => void;
  onSelect: (profileId: string) => void;
  onClose: () => void;
}>;

/**
 * The Add form's profile picker: one tap-to-select row per profile in the
 * context (org profiles in an org context, personal profiles otherwise),
 * matching the web dialog's `Select profile` list. Mounted only while open, and
 * presented through `SessionPageSheet` so it is a real sheet from either call
 * site rather than content laid into the caller's column.
 */
export function ProfilePickerSheet({
  profiles,
  isLoading,
  isError,
  isRefetching,
  selectedProfileId,
  emptyDescription,
  onCreateProfile,
  onRetry,
  onSelect,
  onClose,
}: Readonly<ProfilePickerSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  let body = null;
  if (isLoading) {
    body = <RowSkeleton />;
  } else if (isError) {
    body = (
      <QueryError
        variant="server"
        placement="top"
        inset="gutter"
        title={t('profiles.loadFailed')}
        onRetry={onRetry}
        isRetrying={isRefetching}
      />
    );
  } else if (profiles.length === 0) {
    body = (
      <EmptyState
        icon={SlidersHorizontal}
        title={t('profiles.emptyTitle')}
        description={emptyDescription}
        placement="top"
        inset="gutter"
        action={
          onCreateProfile === undefined ? undefined : (
            <StateAction
              label={t('profiles.createAction')}
              icon={Plus}
              onPress={onCreateProfile}
            />
          )
        }
      />
    );
  } else {
    body = profiles.map(profile => (
      <ChoiceRow
        key={profile.id}
        label={profile.name}
        description={profile.isDefault ? t('profiles.defaultSectionTitle') : undefined}
        selected={profile.id === selectedProfileId}
        onPress={() => {
          onSelect(profile.id);
        }}
      />
    ));
  }

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={t('profiles.repoBindings.profile')}
        onDone={onClose}
        onCancel={onClose}
        doneLabel={t('common.done')}
        cancelLabel={t('common.cancel')}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-4"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
