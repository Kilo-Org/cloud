'use client';
import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitialsFromName, formatLargeNumber } from '@/lib/utils';
import { type UsageProfile } from './types';

type UsageProfileHeroProps = {
  profile: UsageProfile | undefined;
  loading: boolean;
  error: Error | null;
};

type HeatmapRange = '30d' | '90d' | '1y';

const HEATMAP_RANGES: { value: HeatmapRange; label: string }[] = [
  { value: '30d', label: 'Past 30 days' },
  { value: '90d', label: 'Past 90 days' },
  { value: '1y', label: 'Past year' },
];

function computeStreaks(dailyActivity: { date: string; tokens: number }[]): {
  currentStreak: number;
  longestStreak: number;
} {
  if (dailyActivity.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Sort by date ascending
  const sorted = [...dailyActivity].sort((a, b) => a.date.localeCompare(b.date));

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  // Convert to a map for quick lookup
  const dayMap = new Map<string, number>();
  for (const day of sorted) {
    dayMap.set(day.date, day.tokens);
  }

  // Build a list of all days in range with 0 for missing days
  const startDate = new Date(sorted[0].date);
  const endDate = new Date(todayStr);

  const allDays: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    allDays.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // Compute current streak: consecutive active days ending today
  let currentStreak = 0;
  for (let i = allDays.length - 1; i >= 0; i--) {
    if ((dayMap.get(allDays[i]) ?? 0) > 0) {
      currentStreak++;
    } else {
      break;
    }
  }

  // Compute longest streak: max consecutive active days
  let longestStreak = 0;
  let runningStreak = 0;
  for (const dateStr of allDays) {
    if ((dayMap.get(dateStr) ?? 0) > 0) {
      runningStreak++;
      longestStreak = Math.max(longestStreak, runningStreak);
    } else {
      runningStreak = 0;
    }
  }

  return { currentStreak, longestStreak };
}

export function UsageProfileHero({ profile, loading, error }: UsageProfileHeroProps) {
  const fullName = profile?.name ?? '';
  const email = profile?.email ?? '';
  const initials = loading ? '' : getInitialsFromName(fullName) || getInitialsFromName(email);

  const { currentStreak, longestStreak } = useMemo(() => {
    return computeStreaks(profile?.dailyActivity ?? []);
  }, [profile?.dailyActivity]);

  return (
    <div className="flex flex-col items-center gap-6">
      <ProfileHeader
        initials={loading ? undefined : initials}
        name={loading ? undefined : fullName}
        imageUrl={loading ? undefined : profile?.imageUrl}
      />

      <UsageProfileStats
        lifetimeTokens={profile?.lifetimeTokens}
        peakTokens={profile?.peakTokens}
        currentStreak={currentStreak}
        longestStreak={longestStreak}
        loading={loading}
      />

      <TokenActivityHeatmap
        dailyActivity={profile?.dailyActivity ?? []}
        loading={loading}
        error={error?.message ?? null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile Header
// ---------------------------------------------------------------------------

type ProfileHeaderProps = {
  initials?: string;
  name?: string;
  imageUrl?: string;
};

function ProfileHeader({ initials = '', name, imageUrl }: ProfileHeaderProps) {
  return (
    <div className="flex flex-col items-center gap-3">
      <Avatar className="h-20 w-20 border border-border">
        <AvatarImage src={imageUrl} alt={name} />
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="text-center">
        {name ? (
          <h1 className="text-lg font-semibold text-foreground">{name}</h1>
        ) : (
          <Skeleton className="mx-auto h-5 w-32" />
        )}
        <p className="text-sm text-muted-foreground">Personal usage</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage Profile Stats
// ---------------------------------------------------------------------------

type UsageProfileStatsProps = {
  lifetimeTokens?: number;
  peakTokens?: number;
  currentStreak: number;
  longestStreak: number;
  loading: boolean;
};

function UsageProfileStats({
  lifetimeTokens,
  peakTokens,
  currentStreak,
  longestStreak,
  loading,
}: UsageProfileStatsProps) {
  return (
    <Card className="w-full">
      <CardContent className="p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Lifetime tokens"
            value={lifetimeTokens != null ? formatLargeNumber(lifetimeTokens) : undefined}
            loading={loading}
          />
          <KpiTile
            label="Peak tokens"
            value={peakTokens != null ? formatLargeNumber(peakTokens) : undefined}
            loading={loading}
          />
          <KpiTile
            label="Current streak"
            value={`${currentStreak} day${currentStreak !== 1 ? 's' : ''}`}
            loading={loading}
          />
          <KpiTile
            label="Longest streak"
            value={`${longestStreak} day${longestStreak !== 1 ? 's' : ''}`}
            loading={loading}
          />
        </div>
      </CardContent>
    </Card>
  );
}

type KpiTileProps = {
  label: string;
  value?: string;
  loading: boolean;
};

function KpiTile({ label, value, loading }: KpiTileProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-center">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
        {loading ? <Skeleton className="mx-auto h-5 w-16" /> : (value ?? '—')}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token Activity Heatmap
// ---------------------------------------------------------------------------

type TokenActivityHeatmapProps = {
  dailyActivity: { date: string; tokens: number }[];
  loading: boolean;
  error: string | null;
};

function TokenActivityHeatmap({ dailyActivity, loading, error }: TokenActivityHeatmapProps) {
  const [range, setRange] = useState<HeatmapRange>('1y');

  const heatmapData = useMemo(() => {
    // Build a map for quick lookup
    const dayMap = new Map<string, number>();
    for (const day of dailyActivity) {
      dayMap.set(day.date, day.tokens);
    }

    // Determine date range
    const days = range === '30d' ? 30 : range === '90d' ? 90 : 365;
    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - days);

    // Build all days in the range
    const allDays: { date: string; tokens: number }[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
      const dateStr = current.toISOString().slice(0, 10);
      allDays.push({ date: dateStr, tokens: dayMap.get(dateStr) ?? 0 });
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return organizeHeatmap(allDays);
  }, [dailyActivity, range]);

  const maxTokens = useMemo(() => {
    return Math.max(1, ...heatmapData.flatMap(week => week.map(d => d?.tokens ?? 0)));
  }, [heatmapData]);

  const intensityForTokens = (tokens: number) => {
    if (tokens === 0) return 'bg-muted/30';
    const ratio = tokens / maxTokens;
    if (ratio < 0.2) return 'bg-chart-2/30';
    if (ratio < 0.4) return 'bg-chart-2/60';
    if (ratio < 0.6) return 'bg-chart-1/70';
    return 'bg-chart-1';
  };

  return (
    <Card className="w-full">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Token activity</h2>
          <Tabs value={range} onValueChange={v => setRange(v as HeatmapRange)}>
            <TabsList className="h-7">
              {HEATMAP_RANGES.map(r => (
                <TabsTrigger key={r.value} value={r.value} className="text-xs">
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {loading ? (
          <HeatmapSkeleton />
        ) : (
          <>
            {error && <p className="mb-2 text-xs text-muted-foreground">{error}</p>}
            <TooltipProvider delayDuration={0}>
              <HeatmapGrid data={heatmapData} intensityForTokens={intensityForTokens} />
            </TooltipProvider>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HeatmapSkeleton() {
  return (
    <div
      className="h-32 w-full animate-pulse rounded-lg bg-muted/20"
      style={{ maxWidth: '100%' }}
    />
  );
}

type HeatmapGridProps = {
  data: Array<Array<{ date: string; tokens: number } | null>>;
  intensityForTokens: (tokens: number) => string;
};

function HeatmapGrid({ data, intensityForTokens }: HeatmapGridProps) {
  const monthHeaders = useMemo(() => {
    const headers: Array<{ month: string; colspan: number }> = [];
    let currentMonth = '';
    let colspan = 0;

    data.forEach(week => {
      const validDay = week.find(d => d !== null);
      if (!validDay) return;

      const date = new Date(validDay.date + 'T00:00:00Z');
      const monthName = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

      if (monthName !== currentMonth) {
        if (currentMonth && colspan > 0) {
          headers.push({ month: currentMonth, colspan });
        }
        currentMonth = monthName;
        colspan = 1;
      } else {
        colspan++;
      }
    });

    if (currentMonth && colspan > 0) {
      headers.push({ month: currentMonth, colspan });
    }

    return headers;
  }, [data]);

  const formatTooltipDate = (dateString: string) => {
    const dateObj = new Date(dateString + 'T00:00:00Z');
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const month = monthNames[dateObj.getUTCMonth()];
    const day = dateObj.getUTCDate();
    const year = dateObj.getUTCFullYear();
    return `${month} ${day}, ${year}`;
  };

  return (
    <div className="overflow-x-auto">
      <div className="min-w-fit">
        <div className="mb-1 flex gap-1 pl-9">
          {monthHeaders.map((header, index) => (
            <div
              key={index}
              className="text-xs text-muted-foreground"
              style={{ width: `${header.colspan * 14 + (header.colspan - 1) * 4}px` }}
            >
              {header.month}
            </div>
          ))}
        </div>

        <div className="flex">
          <div
            className="mr-2 grid gap-1"
            style={{ gridTemplateRows: 'repeat(7, 14px)', width: '20px' }}
          >
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, row) => (
              <div
                key={row}
                className="flex h-3.5 items-center text-xs text-muted-foreground"
                style={{ gridRow: row + 1 }}
              >
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-flow-col gap-1" style={{ gridTemplateRows: 'repeat(7, 14px)' }}>
            {data.map((week, weekIndex) =>
              week.map((day, dayIndex) => {
                if (!day) {
                  return (
                    <div
                      key={`${weekIndex}-${dayIndex}`}
                      style={{ gridRow: dayIndex + 1, gridColumn: weekIndex + 1 }}
                    />
                  );
                }

                const cell = (
                  <div
                    key={`${weekIndex}-${dayIndex}`}
                    className={`h-3.5 w-3.5 rounded-sm transition-all ${intensityForTokens(day.tokens)} hover:ring-2 hover:ring-primary/50`}
                    style={{ gridRow: dayIndex + 1, gridColumn: weekIndex + 1 }}
                  />
                );

                if (day.tokens === 0)
                  return (
                    <Tooltip key={`${weekIndex}-${dayIndex}`}>
                      <TooltipTrigger asChild>{cell}</TooltipTrigger>
                      <TooltipContent>
                        <div>
                          <div className="font-medium">{formatTooltipDate(day.date)}</div>
                          <div className="text-xs">No usage</div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );

                return (
                  <Tooltip key={`${weekIndex}-${dayIndex}`}>
                    <TooltipTrigger asChild>{cell}</TooltipTrigger>
                    <TooltipContent>
                      <div>
                        <div className="font-medium">{formatTooltipDate(day.date)}</div>
                        <div className="text-xs">
                          {formatLargeNumber(day.tokens)} token{day.tokens !== 1 ? 's' : ''}
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function organizeHeatmap(
  dailyActivity: { date: string; tokens: number }[]
): Array<Array<{ date: string; tokens: number } | null>> {
  const result: Array<Array<{ date: string; tokens: number } | null>> = [];

  if (dailyActivity.length === 0) return result;

  // Build weeks starting from Sunday before startDate
  const firstDate = new Date(dailyActivity[0].date + 'T00:00:00Z');
  const firstDayOfWeek = firstDate.getUTCDay();

  // Add null padding for days before the first date
  const firstWeek: Array<{ date: string; tokens: number } | null> = [];
  for (let i = 0; i < firstDayOfWeek; i++) {
    firstWeek.push(null);
  }

  let currentWeek = firstWeek;
  for (const day of dailyActivity) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      result.push(currentWeek);
      currentWeek = [];
    }
  }

  // Add the last incomplete week if needed
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) {
      currentWeek.push(null);
    }
    result.push(currentWeek);
  }

  return result;
}
