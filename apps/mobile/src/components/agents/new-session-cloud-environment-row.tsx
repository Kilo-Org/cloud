import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { LINE_ACTION_BOX_CLASS, LINE_ACTION_HIT_SLOP, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import {
  buildSummaryLabel,
  type EnvironmentBuildStatusRow,
} from '@/lib/cloud-environments/environment-build-copy';
import { type EnvironmentSelection } from '@/lib/cloud-environments/environment-selection';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type NewSessionCloudEnvironmentRowProps = {
  selection: EnvironmentSelection;
  /** The list failed to load; Retry re-reads it. */
  isError: boolean;
  /** The chosen (or only) environment's build, when there is one. */
  buildStatus: EnvironmentBuildStatusRow | undefined;
  /** A create is in flight, so the picker must not open. */
  disabled: boolean;
  onRetry: () => void;
  onOpen: () => void;
};

const CARD_CLASS = cn(
  ROW_TARGET_CLASS,
  'flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5'
);

/**
 * The new-session Environment row: the cloud environment the session starts
 * with, and its snapshot build in one line. Every state renders the same card
 * and the same two reserved lines, so the form never changes height as the
 * list, the pick or the build settles.
 *
 * The label is "Environment"; the row above it picked this form's earlier
 * naming and is the agent profile. Web's form keeps the profile under
 * "Profile", so the two rows name different things on purpose.
 */
export function NewSessionCloudEnvironmentRow({
  selection,
  isError,
  buildStatus,
  disabled,
  onRetry,
  onOpen,
}: Readonly<NewSessionCloudEnvironmentRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  let label = t('agentChat.environment.loadingEnvironments');
  let detail = '';
  let opensPicker = false;
  if (selection.status === 'unknown') {
    label = t('agentChat.environment.couldNotLoadEnvironments');
    detail = t('agentChat.environment.couldNotLoadEnvironmentsDetail');
  } else if (selection.status === 'none') {
    label = t('agentChat.environment.noEnvironment');
    detail = t('agentChat.environment.noEnvironmentDetail');
  } else if (selection.status === 'choose') {
    label = t('agentChat.environment.chooseEnvironment');
    detail = t('agentChat.environment.chooseEnvironmentDetail');
    opensPicker = true;
  } else if (selection.status === 'selected') {
    label = selection.environment.name;
    detail = isError
      ? t('agentChat.environment.couldNotLoadEnvironments')
      : buildSummaryLabel(buildStatus, t);
    opensPicker = true;
  }

  const body = (
    <View className={cn(CARD_CLASS, opensPicker && !disabled && 'active:opacity-70')}>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="min-h-10 text-sm text-muted-foreground" numberOfLines={2}>
          {detail.length > 0 ? detail : '\u00A0\n\u00A0'}
        </Text>
      </View>
      {opensPicker ? <ChevronDown size={18} color={colors.mutedForeground} /> : null}
    </View>
  );

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.environment')}
      </Text>
      {opensPicker ? (
        <Pressable
          onPress={onOpen}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.environment.environmentAccessibility', { label })}
          className={disabled ? 'opacity-60' : undefined}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {selection.status === 'unknown' ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          className={cn(LINE_ACTION_BOX_CLASS, 'mt-1 self-start justify-center active:opacity-70')}
          hitSlop={LINE_ACTION_HIT_SLOP}
        >
          <Text className="text-sm font-medium text-primary">{t('common.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
