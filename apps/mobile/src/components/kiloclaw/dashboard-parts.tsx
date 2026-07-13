import { AlertTriangle, Bot, RefreshCw, Trash2 } from 'lucide-react-native';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { statusLabel, statusTone } from '@/components/kiloclaw/status-badge';
import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { agentColor, toneColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${String(Math.floor(seconds / 60))}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h)}h ${String(m)}m`;
}

type DashboardHeroProps = {
  name: string;
  status: string;
  uptime: number | null | undefined;
};

export function DashboardHero({ name, status, uptime }: Readonly<DashboardHeroProps>) {
  const colors = useThemeColors();
  const tone = statusTone(status);
  const label = statusLabel(status);
  const uptimeStr = uptime == null ? null : formatUptime(uptime);
  const tint = agentColor(name);
  return (
    <View className="flex-row items-center gap-3 px-[22px] pb-4 pt-2">
      <View
        className={cn(
          'h-11 w-11 items-center justify-center rounded-[14px] border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <Bot size={22} color={colors[tint.hueThemeKey]} />
      </View>
      <View className="flex-1">
        <Text className="text-[26px] font-bold tracking-tight text-foreground" numberOfLines={1}>
          {name}
        </Text>
        <View className="mt-1 flex-row items-center gap-1.5">
          <StatusDot tone={tone} />
          <Text
            variant="mono"
            className="text-[10px] uppercase tracking-[1px] text-muted-foreground"
          >
            {uptimeStr ? `${label} · UP ${uptimeStr}` : label}
          </Text>
        </View>
      </View>
    </View>
  );
}

type ServiceDegradedBannerProps = {
  onPress: () => void;
  /** A background status poll failed, so this degraded reading is stale. */
  stale?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
};

function ServiceDegradedBanner({
  onPress,
  stale,
  onRetry,
  isRetrying,
}: Readonly<ServiceDegradedBannerProps>) {
  const colors = useThemeColors();
  const danger = toneColor('danger');
  return (
    <View className="mx-[22px] flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3">
      <Pressable className="flex-1 flex-row items-center gap-3 active:opacity-70" onPress={onPress}>
        <View
          className={cn(
            'h-9 w-9 items-center justify-center rounded-lg border',
            danger.tileBgClass,
            danger.tileBorderClass
          )}
        >
          <AlertTriangle size={16} color={colors.destructive} />
        </View>
        <Text className="flex-1 text-[13px] font-medium text-foreground">
          Service degraded — tap to view status
        </Text>
      </Pressable>
      {stale && onRetry ? (
        <Pressable
          hitSlop={8}
          disabled={isRetrying}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          accessibilityState={{ busy: isRetrying }}
          className="p-1 active:opacity-70"
        >
          {isRetrying ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <RefreshCw size={16} color={colors.mutedForeground} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

type DashboardServiceStatusProps = {
  isError: boolean;
  isFetching: boolean;
  isDegraded: boolean;
  onRetry: () => void;
  onOpenStatusPage: () => void;
};

/**
 * The service-degraded check is optional context. A known-degraded reading
 * takes precedence even if the latest background poll failed — that stale
 * "degraded" signal is more useful than a generic error, so we keep showing
 * it (with a retry affordance) instead of discarding it. Only fall back to
 * the generic error row when there's no degraded data at all.
 */
export function DashboardServiceStatus({
  isError,
  isFetching,
  isDegraded,
  onRetry,
  onOpenStatusPage,
}: Readonly<DashboardServiceStatusProps>) {
  if (isDegraded) {
    return (
      <ServiceDegradedBanner
        onPress={onOpenStatusPage}
        stale={isError}
        onRetry={onRetry}
        isRetrying={isFetching}
      />
    );
  }
  if (isError) {
    return (
      <View className="mx-[22px]">
        <QueryError
          variant="neutral"
          placement="top"
          title="Could not check service status"
          onRetry={onRetry}
          isRetrying={isFetching}
          className="rounded-2xl border border-border bg-card py-4"
        />
      </View>
    );
  }
  return null;
}

/** Row-by-row skeleton for a `StatusCard` group ("Gateway Process" or "Resources"). */
export function StatusCardGroupSkeleton({ rows }: Readonly<{ rows: number }>) {
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card px-4 pb-1 pt-3">
      <Skeleton className="mb-1 h-3 w-24 rounded" />
      {Array.from({ length: rows }, (_, index) => (
        <View
          // eslint-disable-next-line react/no-array-index-key -- static skeleton rows, no reordering
          key={index}
          className={cn(
            'flex-row items-center justify-between py-3',
            index < rows - 1 && 'border-b-[0.5px] border-hair-soft'
          )}
        >
          <Skeleton className="h-3.5 w-20 rounded" />
          <Skeleton className="h-3.5 w-12 rounded" />
        </View>
      ))}
    </View>
  );
}

type DangerZoneProps = {
  pending: boolean;
  onDestroy: () => void;
};

export function DangerZone({ pending, onDestroy }: Readonly<DangerZoneProps>) {
  const colors = useThemeColors();
  return (
    <View className="mx-[22px] gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4">
      <Text variant="eyebrow" className="text-destructive">
        DANGER ZONE
      </Text>
      <Pressable
        disabled={pending}
        accessibilityRole="button"
        accessibilityLabel="Destroy instance"
        accessibilityState={{ busy: pending }}
        className="flex-row items-center justify-center gap-2 rounded-xl bg-destructive px-4 py-2.5 active:opacity-70"
        onPress={onDestroy}
      >
        {pending ? (
          <View className="h-4 w-4 items-center justify-center">
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          </View>
        ) : (
          <Trash2 size={16} color={colors.primaryForeground} />
        )}
        <Text className="text-sm font-semibold text-primary-foreground">
          {pending ? 'Destroying…' : 'Destroy instance'}
        </Text>
      </Pressable>
    </View>
  );
}
