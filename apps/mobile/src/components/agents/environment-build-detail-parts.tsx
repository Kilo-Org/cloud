import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { type EnvironmentBuildAction } from '@/lib/cloud-environments/environment-build-copy';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/** The logs keep their own viewport, so a long build cannot push the action off. */
const LOGS_MAX_WINDOW_FRACTION = 0.3;

/** The build state before the first read settles, or its failure with a retry. */
export function BuildStatusPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  if (failed) {
    return (
      <View className="gap-2">
        <Text className="text-sm text-destructive">
          {t('agentChat.environment.couldNotLoadBuild')}
        </Text>
        <Button variant="outline" size="sm" onPress={onRetry}>
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-2">
      <ActivityIndicator />
      <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
    </View>
  );
}

/** The build log, fetched only while it is expanded. */
export function BuildLogSection({
  open,
  onToggle,
  lines,
  truncated,
  isLoading,
  isError,
  onRetry,
}: {
  open: boolean;
  onToggle: () => void;
  lines: readonly { seq: number; text: string }[];
  /** The build kept only its first lines; later output was dropped. */
  truncated: boolean;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { height: windowHeight } = useWindowDimensions();
  return (
    <>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t('agentChat.environment.buildLogs')}
        className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-2 active:opacity-70')}
      >
        {open ? (
          <ChevronDown size={16} color={colors.mutedForeground} />
        ) : (
          <DirectionalChevronRight size={16} color={colors.mutedForeground} />
        )}
        <Text className="text-sm font-medium text-foreground">
          {t('agentChat.environment.buildLogs')}
        </Text>
      </Pressable>
      {open ? (
        <View className="gap-2">
          {isError ? (
            <>
              <Text className="text-sm text-destructive">
                {t('agentChat.environment.couldNotLoadBuildLogs')}
              </Text>
              <Button variant="outline" size="sm" onPress={onRetry}>
                <Text>{t('common.retry')}</Text>
              </Button>
            </>
          ) : null}
          {isLoading ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator />
              <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
            </View>
          ) : null}
          {!isLoading && !isError && lines.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t('agentChat.environment.noBuildLogs')}
            </Text>
          ) : null}
          {lines.length > 0 ? (
            <View className="gap-1">
              {/* The read returns the latest retained lines, so a log that starts
                  past its first line is shown without its beginning, and a
                  truncated one lost its tail; saying so keeps a partial log from
                  reading as the whole build. */}
              {(lines[0]?.seq ?? 0) > 1 ? (
                <Text className="text-xs text-muted-foreground">
                  {t('agentChat.environment.buildLogsLatestOnly')}
                </Text>
              ) : null}
              {truncated ? (
                <Text className="text-xs text-muted-foreground">
                  {t('agentChat.environment.buildLogsTruncated')}
                </Text>
              ) : null}
              <View className="overflow-hidden rounded-md border border-border bg-card">
                <ScrollView
                  style={{ maxHeight: Math.round(windowHeight * LOGS_MAX_WINDOW_FRACTION) }}
                  contentContainerClassName="p-2"
                >
                  <Text selectable className="font-mono text-xs text-foreground">
                    {lines.map(line => line.text).join('\n')}
                  </Text>
                </ScrollView>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** The one control the web offers, or the reason it is unavailable. */
export function BuildControl({
  action,
  isSubmitting,
  onBuild,
  onCancel,
}: {
  action: EnvironmentBuildAction;
  isSubmitting: boolean;
  onBuild: () => void;
  onCancel: (buildId: string) => void;
}) {
  const { t } = useTranslation();
  if (action.kind === 'none') {
    return <Text className="text-sm text-muted-foreground">{action.message}</Text>;
  }
  if (action.kind === 'cancel') {
    return (
      <Button
        variant="outline-destructive"
        size="action"
        loading={isSubmitting}
        onPress={() => {
          onCancel(action.buildId);
        }}
      >
        <Text className="text-destructive">{t('agentChat.environment.cancelBuildAction')}</Text>
      </Button>
    );
  }
  return (
    <Button size="action" loading={isSubmitting} onPress={onBuild}>
      <Text>
        {action.kind === 'refresh'
          ? t('agentChat.environment.refreshAction')
          : t('agentChat.environment.buildAction')}
      </Text>
    </Button>
  );
}
