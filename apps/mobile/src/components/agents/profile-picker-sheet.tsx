import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import {
  sessionProfileCountItems,
  type SessionProfilePickerProfile,
} from '@/components/agents/session-profile-picker-model';
import { Button } from '@/components/ui/button';
import { Check, Settings2 } from '@/components/ui/icons';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatProfileCountItems } from '@/lib/profile-count-labels';

const SKELETON_ROW_COUNT = 4;

export type ProfilePickerSheetProps = {
  /** Rows offered as an override: every profile except the repo base. */
  candidates: readonly SessionProfilePickerProfile[];
  /** Whether any profile exists at all; false renders the empty state. */
  hasProfiles: boolean;
  /** The user's explicit pick, or null when the effective default applies. */
  selectedOverrideProfileId: string | null;
  /**
   * Whether an effective default applies when no override is picked. The
   * no-override row then clears the pick and that default is what the session
   * runs on, so the row names the default instead of claiming no profile.
   */
  defaultProfileApplies: boolean;
  isLoading: boolean;
  isError: boolean;
  /** The picked id no longer resolves to a profile. */
  needsAttention: boolean;
  onSelect: (id: string | null) => void;
  onManageProfiles: () => void;
  onRetry: () => void;
  onClose: () => void;
};

/**
 * The session-start profile picker body: the no-override row plus one row per
 * candidate, with the manage-profiles entry. Presented by
 * `agent-chat/profile-picker` inside the app's standard native formSheet, so
 * dismissal is the sheet's swipe-down or this header's Cancel.
 */
export function ProfilePickerSheet({
  candidates,
  hasProfiles,
  defaultProfileApplies,
  selectedOverrideProfileId,
  isLoading,
  isError,
  needsAttention,
  onSelect,
  onManageProfiles,
  onRetry,
  onClose,
}: Readonly<ProfilePickerSheetProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const title = t('agentChat.newSession.pickProfile');
  // Clearing the override hands the session to the effective default, so the
  // row names that default instead of claiming no profile is active.
  const noOverrideLabelKey = defaultProfileApplies
    ? 'profiles.defaultSectionTitle'
    : 'agentChat.newSession.noProfile';

  if (isLoading) {
    return (
      <PickerSheet title={title} onDone={onClose} scrollable={false}>
        <View className="bg-background">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <View key={index} className="px-4 py-3">
              <Skeleton className="h-5 w-2/3 rounded-md" />
            </View>
          ))}
        </View>
      </PickerSheet>
    );
  }

  if (isError) {
    return (
      <PickerSheet title={title} onDone={onClose} scrollable={false}>
        <EmptyState
          icon={Settings2}
          title={t('agentChat.newSession.couldNotLoadEnvironment')}
          description={t('organization.boundary.loadErrorMessage')}
          action={
            <Button variant="outline" onPress={onRetry} accessibilityLabel={t('common.retry')}>
              <Text>{t('common.retry')}</Text>
            </Button>
          }
        />
      </PickerSheet>
    );
  }

  if (!hasProfiles) {
    return (
      <PickerSheet title={title} onDone={onClose} scrollable={false}>
        <EmptyState
          icon={Settings2}
          title={title}
          description={t('agentChat.newSession.noProfiles')}
          action={
            <Button
              variant="outline"
              onPress={onManageProfiles}
              accessibilityLabel={t('agentChat.newSession.manageProfiles')}
            >
              <Text>{t('agentChat.newSession.manageProfiles')}</Text>
            </Button>
          }
        />
      </PickerSheet>
    );
  }

  return (
    <PickerSheet title={title} onDone={onClose} onCancel={onClose}>
      {needsAttention ? (
        <Text className="px-4 pt-3 text-sm text-warn">
          {t('agentChat.newSession.configNeedsAttention')}
        </Text>
      ) : null}
      <RadioGroup label={title} className="py-1">
        <Pressable
          className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 active:bg-secondary"
          onPress={() => {
            onSelect(null);
          }}
          {...radioItemA11y({
            label: t(noOverrideLabelKey),
            checked: selectedOverrideProfileId === null && !needsAttention,
          })}
        >
          <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
            {t(noOverrideLabelKey)}
          </Text>
          {selectedOverrideProfileId === null && !needsAttention ? (
            <Check size={18} color={colors.primary} />
          ) : null}
        </Pressable>

        {candidates.map(candidate => {
          const selected = candidate.id === selectedOverrideProfileId;
          const counts = formatProfileCountItems(t, sessionProfileCountItems(candidate)).join(
            ' · '
          );
          return (
            <Pressable
              key={candidate.id}
              className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 active:bg-secondary"
              onPress={() => {
                onSelect(candidate.id === selectedOverrideProfileId ? null : candidate.id);
              }}
              {...radioItemA11y({ label: candidate.name, checked: selected })}
            >
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {candidate.name}
                </Text>
                {counts ? (
                  <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                    {counts}
                  </Text>
                ) : null}
              </View>
              {selected ? <Check size={18} color={colors.primary} /> : null}
            </Pressable>
          );
        })}
      </RadioGroup>

      <View className="px-4 pt-3">
        <Button
          variant="outline"
          onPress={onManageProfiles}
          accessibilityLabel={t('agentChat.newSession.manageProfiles')}
        >
          <Text>{t('agentChat.newSession.manageProfiles')}</Text>
        </Button>
      </View>
    </PickerSheet>
  );
}
