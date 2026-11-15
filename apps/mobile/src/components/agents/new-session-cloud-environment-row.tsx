import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type TFunction } from 'i18next';

import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import {
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  ROW_TARGET_CLASS,
} from '@/lib/a11y/tap-target';
import {
  buildSummaryLabel,
  type EnvironmentBuildStatusRow,
} from '@/lib/cloud-environments/environment-build-copy';
import { type EnvironmentSelection } from '@/lib/cloud-environments/environment-selection';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type NewSessionCloudEnvironmentRowProps = {
  /** `idle` never reaches this row: the form hides it until a repository is picked. */
  selection: Exclude<EnvironmentSelection, { status: 'idle' }>;
  /** The list failed to load; Retry re-reads it. */
  isError: boolean;
  /** The chosen (or only) environment's build, when there is one. */
  buildStatus: EnvironmentBuildStatusRow | undefined;
  /** The build status read failed, so the row must not claim to be loading it. */
  buildStatusFailed: boolean;
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
 * The build line under the picked environment: a failed list, a failed build
 * status, or the build itself. A failed read must not read as still loading.
 */
function selectedBuildDetail({
  isError,
  buildStatusFailed,
  buildStatus,
  t,
}: {
  isError: boolean;
  buildStatusFailed: boolean;
  buildStatus: EnvironmentBuildStatusRow | undefined;
  t: TFunction;
}): string {
  if (isError) {
    return t('agentChat.environment.couldNotLoadEnvironments');
  }
  if (buildStatusFailed) {
    return t('agentChat.environment.couldNotLoadBuild');
  }
  return buildSummaryLabel(buildStatus, t);
}

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
  buildStatusFailed,
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
    detail = selectedBuildDetail({ isError, buildStatusFailed, buildStatus, t });
    opensPicker = true;
  }

  const body = (
    <>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="min-h-10 text-sm text-muted-foreground" numberOfLines={2}>
          {detail.length > 0 ? detail : '\u00A0\n\u00A0'}
        </Text>
      </View>
      {opensPicker ? <ChevronDown size={18} color={colors.mutedForeground} /> : null}
    </>
  );

  const canOpen = opensPicker && !disabled;

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.cloudEnvironment')}
      </Text>
      {/* The card's own chrome lives on the Pressable, exactly as the profile
          row below does, and the Pressable is never flattened: an unstyled
          Pressable around a styled card collapses into that card's native view
          and then paints without ever receiving a touch, so no press handler
          fires in any pickable state. `onPress` carries the disable instead of
          the `disabled` prop, which also suppresses press-in. */}
      {opensPicker ? (
        <Pressable
          testID="session-cloud-environment-row"
          onPress={canOpen ? onOpen : undefined}
          collapsable={false}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canOpen }}
          accessibilityLabel={t('agentChat.environment.environmentAccessibility', { label })}
          className={cn(CARD_CLASS, canOpen ? 'active:opacity-70' : 'opacity-60')}
        >
          {body}
        </Pressable>
      ) : (
        <View testID="session-cloud-environment-row" className={CARD_CLASS}>
          {body}
        </View>
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
