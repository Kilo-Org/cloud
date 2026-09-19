import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { EmptyState } from '@/components/empty-state';
import { SlidersHorizontal } from '@/components/ui/icons';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type AgentProfileListItem } from '@/lib/hooks/use-agent-profiles';

type ProfilePickerSheetProps = Readonly<{
  profiles: readonly AgentProfileListItem[];
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  selectedProfileId: string;
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
  onRetry,
  onSelect,
  onClose,
}: Readonly<ProfilePickerSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  let body = null;
  if (isLoading) {
    body = <Skeleton className="mx-4 h-14 w-full rounded-md bg-muted-soft" />;
  } else if (isError) {
    body = (
      <QueryError
        variant="server"
        placement="top"
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
        description={t('profiles.emptyDescription')}
        placement="top"
      />
    );
  } else {
    body = profiles.map(profile => (
      <Pressable
        key={profile.id}
        className="min-h-11 flex-row items-center gap-2 px-4 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={profile.name}
        accessibilityState={{ selected: profile.id === selectedProfileId }}
        onPress={() => {
          onSelect(profile.id);
        }}
      >
        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {profile.name}
        </Text>
        {profile.isDefault ? (
          <Text className="text-xs text-muted-foreground">{t('profiles.defaultSectionTitle')}</Text>
        ) : null}
      </Pressable>
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
