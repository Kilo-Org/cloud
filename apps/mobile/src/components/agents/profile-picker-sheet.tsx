import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { type SheetHeaderTopInset } from '@/components/sheet-header';
import { type SessionProfilePickerProfile } from '@/components/agents/session-profile-picker-model';
import { Button } from '@/components/ui/button';
import { Check, Settings2 } from '@/components/ui/icons';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatProfileCountItems, profileCountItems } from '@/lib/profile-count-labels';
import { cn } from '@/lib/utils';

const SKELETON_ROW_COUNT = 4;

/**
 * The sheet presents at the half detent and its full detent stops below the
 * status bar, so its header never overlaps the status bar. Reserving that
 * inset anyway moved the title and every row by the inset height once the
 * header measured its own position after presenting; declaring up front that
 * the surface never reaches the window top keeps the first frame identical to
 * the resting one.
 */
const SHEET_TOP_INSET: SheetHeaderTopInset = 'never';

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
  /**
   * The profile the effective default resolves to, when known. The no-override
   * row names it so the checked row matches the Environment chip, which shows
   * that same profile's name.
   */
  defaultProfileName?: string | null;
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
 *
 * Every state renders the same header: Cancel leading, the centred title and
 * Done trailing. Without Cancel the title falls back to leading alignment
 * (SheetHeader centres it between the two controls), so a state that omitted
 * Cancel would redraw the same sheet with a different header.
 */
export function ProfilePickerSheet({
  candidates,
  hasProfiles,
  defaultProfileApplies,
  defaultProfileName,
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
  const noOverrideLabel = t(noOverrideLabelKey);
  // The Environment chip names the profile the default resolves to; the row
  // has to say the same thing, or the checked row and the chip disagree.
  const resolvedDefaultName = defaultProfileApplies ? (defaultProfileName ?? null) : null;
  const noOverrideAccessibilityLabel =
    resolvedDefaultName === null
      ? noOverrideLabel
      : t('agentChat.newSession.defaultProfileResolvesToAccessibility', {
          name: resolvedDefaultName,
        });

  if (isLoading) {
    return (
      <PickerSheet
        title={title}
        onDone={onClose}
        onCancel={onClose}
        scrollable={false}
        topInset={SHEET_TOP_INSET}
      >
        <View className="bg-background">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <View key={index} className={cn(ROW_TARGET_CLASS, 'justify-center px-4 py-3')}>
              <Skeleton className="h-5 w-2/3 rounded-md" />
            </View>
          ))}
        </View>
      </PickerSheet>
    );
  }

  if (isError) {
    return (
      <PickerSheet
        title={title}
        onDone={onClose}
        onCancel={onClose}
        scrollable={false}
        topInset={SHEET_TOP_INSET}
      >
        <EmptyState
          icon={Settings2}
          title={t('agentChat.newSession.couldNotLoadEnvironment')}
          description={t('organization.boundary.loadErrorMessage')}
          action={
            <Button
              variant="outline"
              onPress={onRetry}
              accessibilityLabel={t('common.retry')}
              className={STATE_ACTION_CLASS}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          }
        />
      </PickerSheet>
    );
  }

  if (!hasProfiles) {
    return (
      <PickerSheet
        title={title}
        onDone={onClose}
        onCancel={onClose}
        scrollable={false}
        topInset={SHEET_TOP_INSET}
      >
        <EmptyState
          icon={Settings2}
          // The header already carries the sheet title, so the empty state
          // names the condition instead of repeating it.
          title={t('profiles.emptyTitle')}
          description={t('profiles.emptyDescription')}
          action={
            <Button
              variant="outline"
              onPress={onManageProfiles}
              accessibilityLabel={t('agentChat.newSession.manageProfiles')}
              className={STATE_ACTION_CLASS}
            >
              <Text>{t('agentChat.newSession.manageProfiles')}</Text>
            </Button>
          }
        />
      </PickerSheet>
    );
  }

  return (
    <PickerSheet title={title} onDone={onClose} onCancel={onClose} topInset={SHEET_TOP_INSET}>
      {needsAttention ? (
        <Text className="px-4 pt-3 text-sm text-warn">
          {t('agentChat.newSession.configNeedsAttention')}
        </Text>
      ) : null}
      <RadioGroup label={title} className="py-1">
        <Pressable
          className={cn(
            ROW_TARGET_CLASS,
            'flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 active:bg-secondary'
          )}
          onPress={() => {
            onSelect(null);
          }}
          {...radioItemA11y({
            label: noOverrideAccessibilityLabel,
            checked: selectedOverrideProfileId === null && !needsAttention,
          })}
        >
          <View className="min-w-0 flex-1">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {noOverrideLabel}
            </Text>
            {resolvedDefaultName === null ? null : (
              <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                {t('agentChat.newSession.defaultProfileResolvesTo', { name: resolvedDefaultName })}
              </Text>
            )}
          </View>
          {selectedOverrideProfileId === null && !needsAttention ? (
            <Check size={18} color={colors.primary} />
          ) : null}
        </Pressable>

        {candidates.map(candidate => {
          const selected = candidate.id === selectedOverrideProfileId;
          const counts = formatProfileCountItems(t, profileCountItems(candidate)).join(' · ');
          return (
            <Pressable
              key={candidate.id}
              className={cn(
                ROW_TARGET_CLASS,
                'flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 active:bg-secondary'
              )}
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
                  <Text className="text-sm text-muted-foreground" numberOfLines={2}>
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
