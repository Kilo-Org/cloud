import { useState } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { SheetHeader } from '@/components/sheet-header';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Check } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import {
  buildSummaryLabel,
  type EnvironmentBuildStatusRow,
} from '@/lib/cloud-environments/environment-build-copy';
import { type EnvironmentSummaryRow } from '@/lib/cloud-environments/environment-selection';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { EnvironmentBuildDetail } from './environment-build-detail';

/** The share of the window a list may fill before it scrolls inside the sheet. */
const LIST_MAX_WINDOW_FRACTION = 0.5;

type EnvironmentSheetProps = {
  visible: boolean;
  onClose: () => void;
  environments: readonly EnvironmentSummaryRow[];
  selectedEnvironmentId: string | null;
  repositoryLabel: string;
  organizationId: string | undefined;
  /** The build of one environment, owned by the form that opened this sheet. */
  buildStatusFor: (environmentId: string) => EnvironmentBuildStatusRow | undefined;
  buildStatusFailed: boolean;
  onRetryBuildStatus: () => void;
  onChoose: (environmentId: string) => void;
};

/**
 * The new-session environment sheet: the environments that contain the selected
 * repository, and the build view of one of them.
 *
 * One native sheet holds both views. The list picks one; its build control opens
 * that environment's build, where a running or failed snapshot shows its state,
 * its log, and the one control the web offers — Build, Refresh, or Cancel. Back
 * returns to the list instead of stacking a second native sheet over the first.
 */
export function EnvironmentSheet({
  visible,
  onClose,
  environments,
  selectedEnvironmentId,
  repositoryLabel,
  organizationId,
  buildStatusFor,
  buildStatusFailed,
  onRetryBuildStatus,
  onChoose,
}: Readonly<EnvironmentSheetProps>) {
  if (!visible) {
    return null;
  }
  return (
    <EnvironmentSheetBody
      onClose={onClose}
      environments={environments}
      selectedEnvironmentId={selectedEnvironmentId}
      repositoryLabel={repositoryLabel}
      organizationId={organizationId}
      buildStatusFor={buildStatusFor}
      buildStatusFailed={buildStatusFailed}
      onRetryBuildStatus={onRetryBuildStatus}
      onChoose={onChoose}
    />
  );
}

function EnvironmentSheetBody({
  onClose,
  environments,
  selectedEnvironmentId,
  repositoryLabel,
  organizationId,
  buildStatusFor,
  buildStatusFailed,
  onRetryBuildStatus,
  onChoose,
}: Readonly<Omit<EnvironmentSheetProps, 'visible'>>) {
  const insets = useSafeAreaInsets();
  const [openEnvironmentId, setOpenEnvironmentId] = useState<string | null>(null);
  const openEnvironment = environments.find(
    environment => environment.id === openEnvironmentId
  );

  return (
    <Sheet visible onClose={onClose}>
      <View style={{ paddingBottom: insets.bottom }}>
        {openEnvironment === undefined ? (
          <EnvironmentList
            environments={environments}
            selectedEnvironmentId={selectedEnvironmentId}
            repositoryLabel={repositoryLabel}
            buildStatusFor={buildStatusFor}
            buildStatusFailed={buildStatusFailed}
            onChoose={environmentId => {
              onChoose(environmentId);
              onClose();
            }}
            onOpenBuild={setOpenEnvironmentId}
            onClose={onClose}
          />
        ) : (
          <EnvironmentBuildDetail
            environment={openEnvironment}
            status={buildStatusFor(openEnvironment.id)}
            buildStatusFailed={buildStatusFailed}
            organizationId={organizationId}
            onRetryBuildStatus={onRetryBuildStatus}
            onBack={() => {
              setOpenEnvironmentId(null);
            }}
            onClose={() => {
              onChoose(openEnvironment.id);
              onClose();
            }}
          />
        )}
      </View>
    </Sheet>
  );
}

function EnvironmentList({
  environments,
  selectedEnvironmentId,
  repositoryLabel,
  buildStatusFor,
  buildStatusFailed,
  onChoose,
  onOpenBuild,
  onClose,
}: {
  environments: readonly EnvironmentSummaryRow[];
  selectedEnvironmentId: string | null;
  repositoryLabel: string;
  buildStatusFor: (environmentId: string) => EnvironmentBuildStatusRow | undefined;
  buildStatusFailed: boolean;
  onChoose: (environmentId: string) => void;
  onOpenBuild: (environmentId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  return (
    <>
      <SheetHeader title={t('agentChat.newSession.environment')} onDone={onClose} />
      <Text className="px-4 pb-2 text-sm text-muted-foreground" numberOfLines={1}>
        {t('agentChat.environment.environmentsForRepository', { repository: repositoryLabel })}
      </Text>
      <ScrollView style={{ maxHeight: Math.round(windowHeight * LIST_MAX_WINDOW_FRACTION) }}>
        {environments.map(environment => (
          <EnvironmentListRow
            key={environment.id}
            environment={environment}
            status={buildStatusFor(environment.id)}
            statusFailed={buildStatusFailed}
            selected={environment.id === selectedEnvironmentId}
            onChoose={onChoose}
            onOpenBuild={onOpenBuild}
          />
        ))}
      </ScrollView>
    </>
  );
}

function EnvironmentListRow({
  environment,
  status,
  statusFailed,
  selected,
  onChoose,
  onOpenBuild,
}: {
  environment: EnvironmentSummaryRow;
  status: EnvironmentBuildStatusRow | undefined;
  statusFailed: boolean;
  selected: boolean;
  onChoose: (environmentId: string) => void;
  onOpenBuild: (environmentId: string) => void;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const buildLine =
    statusFailed && status === undefined ? t('common.unknown') : buildSummaryLabel(status, t);
  return (
    <View className="flex-row items-center border-t border-border">
      <Pressable
        onPress={() => {
          onChoose(environment.id);
        }}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={environment.name}
        className={cn(ROW_TARGET_CLASS, 'min-w-0 flex-1 flex-row items-center gap-3 py-3 ps-4')}
      >
        <View className="w-5 items-center">
          {selected ? <Check size={16} color={colors.foreground} /> : null}
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {environment.name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {buildLine}
          </Text>
        </View>
      </Pressable>
      <Pressable
        onPress={() => {
          onOpenBuild(environment.id);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.environment.buildDetails')}
        className="flex-row items-center gap-1 py-3 ps-2 pe-4 active:opacity-70"
        hitSlop={{ top: 4, bottom: 4 }}
      >
        <Text className="text-xs font-medium text-primary">
          {t('agentChat.environment.buildDetails')}
        </Text>
        <DirectionalChevronRight size={14} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}
