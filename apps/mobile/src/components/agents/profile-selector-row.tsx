import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import {
  profileSelectorCountItems,
  type ProfileSelectorProfile,
  type ProfileSelectorRow,
  type ProfileSelectorState,
} from '@/components/agents/profile-selector-model';
import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import {
  AlertCircle,
  Building2,
  ChevronDown,
  GitBranch,
  Settings,
  Settings2,
  Star,
  User,
} from '@/components/ui/icons';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatProfileCountItems } from '@/lib/profile-count-labels';

type ProfileSelectorRowProps = Readonly<{
  state: ProfileSelectorState;
  /** The profiles query is in flight and holds no rows yet. */
  isLoading: boolean;
  /** The profiles query failed; the row offers Retry. */
  isError: boolean;
  disabled?: boolean;
  onRetry: () => void;
  onSelect: (profileId: string | null) => void;
  onManageProfiles: () => void;
  /** Opens the repo default-profile bindings; omitted until that surface exists. */
  onRepoDefaults?: () => void;
}>;

/**
 * The advanced-config profile selector: a closed row that opens the app's
 * native page sheet with the profile option model. Mobile-first — the sheet is
 * a tap list, never a select control that needs drag.
 */
export function ProfileSelectorRow({
  state,
  isLoading,
  isError,
  disabled = false,
  onRetry,
  onSelect,
  onManageProfiles,
  onRepoDefaults,
}: Readonly<ProfileSelectorRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [isOpen, setIsOpen] = useState(false);

  const close = () => {
    setIsOpen(false);
  };

  const choose = (profileId: string | null) => {
    onSelect(profileId);
    close();
  };

  const renderRow = (row: ProfileSelectorRow) => {
    if (row.kind === 'header') {
      return (
        <Text
          key={row.key}
          className="px-4 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {t(row.labelKey)}
        </Text>
      );
    }
    if (row.kind === 'none') {
      return (
        <Pressable
          key={row.key}
          className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 active:bg-secondary"
          onPress={() => {
            choose(null);
          }}
          {...radioItemA11y({ label: t(row.labelKey), checked: state.selectedProfile === null })}
        >
          <Text className="flex-1 text-base text-muted-foreground" numberOfLines={1}>
            {t(row.labelKey)}
          </Text>
        </Pressable>
      );
    }
    if (row.kind === 'manage' || row.kind === 'repo-defaults') {
      // Rendered below the radio group as the fixed actions.
      return null;
    }
    const profile = row.profile;
    const counts = formatProfileCountItems(t, profileSelectorCountItems(profile)).join(', ');
    return (
      <Pressable
        key={row.key}
        className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 active:bg-secondary"
        onPress={() => {
          choose(profile.id);
        }}
        {...radioItemA11y({
          label: profile.name,
          checked: state.selectedProfile?.id === profile.id,
        })}
      >
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <OwnerIcon ownerType={profile.ownerType} color={colors.mutedForeground} />
          <Text className="shrink text-base text-foreground" numberOfLines={1}>
            {profile.name}
          </Text>
          {row.isEffectiveDefault ? (
            <Star size={14} color={colors.primary} fill={colors.primary} />
          ) : null}
        </View>
        {counts === '' ? null : <Text className="text-xs text-muted-foreground">{counts}</Text>}
      </Pressable>
    );
  };

  if (isError) {
    return (
      <View className="min-h-[52px] flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
        <AlertCircle size={16} color={colors.destructive} />
        <Text className="flex-1 text-sm text-destructive">
          {t('agentChat.newSession.failedToLoadProfiles')}
        </Text>
        <Button variant="link" size="sm" onPress={onRetry} accessibilityLabel={t('common.retry')}>
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }

  if (isLoading) {
    return <Skeleton className="h-[52px] w-full rounded-lg" />;
  }

  const selected = state.selectedProfile;

  return (
    <>
      <Pressable
        className="min-h-[52px] flex-row items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 active:opacity-70"
        onPress={() => {
          setIsOpen(true);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.newSession.pickProfile')}
      >
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          {selected ? (
            <OwnerIcon ownerType={selected.ownerType} color={colors.mutedForeground} />
          ) : (
            <Settings2 size={16} color={colors.mutedForeground} />
          )}
          <Text className="shrink text-sm font-medium text-foreground" numberOfLines={1}>
            {selected?.name ?? t(state.noOverrideLabelKey)}
          </Text>
          {selected && state.selectedIsEffectiveDefault ? (
            <Star size={14} color={colors.primary} fill={colors.primary} />
          ) : null}
        </View>
        <ChevronDown size={18} color={colors.mutedForeground} />
      </Pressable>

      <SessionPageSheet visible={isOpen} onClose={close}>
        <SheetHeader
          title={t('agentChat.newSession.pickProfile')}
          onDone={close}
          onCancel={close}
          topInset="ios-page-sheet"
        />
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-8"
          keyboardShouldPersistTaps="handled"
        >
          <RadioGroup label={t('agentChat.newSession.pickProfile')} className="py-1">
            {state.rows.map(renderRow)}
          </RadioGroup>

          <View className="gap-1 px-4 pt-2">
            <Pressable
              className="min-h-11 flex-row items-center gap-2 px-1 py-2 active:opacity-70"
              onPress={() => {
                close();
                onManageProfiles();
              }}
              accessibilityRole="button"
              accessibilityLabel={t('agentChat.newSession.manageProfiles')}
            >
              <Settings size={18} color={colors.foreground} />
              <Text className="text-base font-medium text-foreground">
                {t('agentChat.newSession.manageProfiles')}
              </Text>
            </Pressable>
            {onRepoDefaults ? (
              <Pressable
                className="min-h-11 flex-row items-center gap-2 px-1 py-2 active:opacity-70"
                onPress={() => {
                  close();
                  onRepoDefaults();
                }}
                accessibilityRole="button"
                accessibilityLabel={t('profiles.repoBindings.title')}
              >
                <GitBranch size={18} color={colors.foreground} />
                <Text className="text-base font-medium text-foreground">
                  {t('profiles.repoBindings.title')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </SessionPageSheet>
    </>
  );
}

function OwnerIcon({
  ownerType,
  color,
}: Readonly<{ ownerType: ProfileSelectorProfile['ownerType']; color: string }>) {
  if (ownerType === 'organization') {
    return <Building2 size={16} color={color} />;
  }
  return <User size={16} color={color} />;
}
