import { type Href } from 'expo-router';
import { ChevronDown } from '@/components/ui/icons';
import { Keyboard, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { FIELD_TRIGGER_BODY_CLASS, FIELD_TRIGGER_FRAME_CLASS } from '@/lib/a11y/tap-target';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REPO_PLATFORM_LABEL_KEYS, type RepoPlatform } from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

import { buildRepoSections, type RepoOption, toBridgeRepo } from './repo-sections';

type RepoSelectorProps = {
  value: string;
  repositories: RepoOption[];
  /** Recently used rows, rendered under a "Recently used" section header in the picker. */
  recents: RepoOption[];
  isLoading: boolean;
  /**
   * The organization scope the rows were loaded under; `null` is personal.
   * Published to the picker so its Bitbucket note can key on the LIST's scope
   * rather than on the app's globally selected organization, which can differ.
   */
  organizationId: string | null;
  onChange: (repo: string) => void;
  disabled?: boolean;
};

function isRepoPlatform(platform: string): platform is RepoPlatform {
  return platform === 'github' || platform === 'gitlab' || platform === 'bitbucket';
}

export function RepoSelector({
  value,
  repositories,
  recents,
  isLoading,
  organizationId,
  onChange,
  disabled = false,
}: Readonly<RepoSelectorProps>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();
  // An empty picker explains missing repositories; it must remain reachable.
  const effectivelyDisabled = disabled || isLoading;

  // The selection value is `platform:fullName`; show the platform name next to
  // the fullName so two same-name repos on different providers stay distinct in
  // the closed state. A bare fullName (legacy prefill) falls back to the
  // matching row's platform.
  const colonIndex = value.indexOf(':');
  const rawPlatform = colonIndex !== -1 ? value.slice(0, colonIndex) : '';
  const selectedPlatform: RepoPlatform | undefined =
    colonIndex !== -1 && isRepoPlatform(rawPlatform)
      ? rawPlatform
      : repositories.find(repo => repo.fullName === value)?.platform;
  const displayValue = colonIndex !== -1 ? value.slice(colonIndex + 1) : value;

  // The list owns the placeholder, so an empty field is loading until it
  // settles. A chosen repository keeps its name while a refetch runs, and stays
  // disabled: the picker would open on the same rows.
  if (isLoading && displayValue === '') {
    return (
      <View
        accessible
        accessibilityLabel={t('agentChat.repoPicker.accessibility', {
          label: t('agentChat.repoPicker.loading'),
        })}
        accessibilityState={{ busy: true }}
        className={FIELD_TRIGGER_FRAME_CLASS}
      >
        <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
          {/* The branch row's loading bar: a name-width line, so the field
              reads as the row it becomes. `bg-muted-soft` because the default
              `bg-skeleton-fill` equals this frame's `bg-secondary` in the light
              palette, where the bar would paint nothing. */}
          <Skeleton className="h-4 w-1/3 bg-muted-soft" />
          <ChevronDown size={14} color={colors.mutedForeground} />
        </View>
      </View>
    );
  }

  const platformName = selectedPlatform ? t(REPO_PLATFORM_LABEL_KEYS[selectedPlatform]) : undefined;
  let label = displayValue;
  if (!label) {
    label = t('agentChat.repoPicker.title');
  } else if (platformName) {
    label = `${platformName} · ${displayValue}`;
  }

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    const bridgeRepositories = repositories.map(repo => toBridgeRepo(repo));
    repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
      repositories: bridgeRepositories,
      sections: buildRepoSections({ repositories, recents }),
      currentValue: value,
      organizationId,
      onSelect: onChange,
    });
    // See ModelSelector: the sheet never re-anchors after the keyboard hides,
    // so the keyboard must be down before this push.
    Keyboard.dismiss();
    pushOnce('/(app)/agent-chat/repo-picker' as Href);
  }

  // With nothing chosen the trigger shows its own placeholder, which already names
  // the field and says the choice is open: prefixing it would announce the field
  // name twice ("Repository: Select repository"). A chosen trigger keeps the field
  // prefix, so the value is never mistaken for the field. (The loading field is
  // the skeleton above, which names the field itself.)
  const accessibilityLabel =
    displayValue === '' ? label : t('agentChat.repoPicker.accessibility', { label });

  return (
    <Pressable
      onPress={handlePress}
      disabled={effectivelyDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: effectivelyDisabled }}
      className={cn(FIELD_TRIGGER_FRAME_CLASS, effectivelyDisabled && 'opacity-50')}
    >
      <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
        <Text
          className={cn(
            'min-w-0 flex-1 text-base',
            value ? 'text-foreground' : 'text-muted-foreground'
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
        <ChevronDown size={14} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}
