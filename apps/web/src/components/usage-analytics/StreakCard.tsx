'use client';
import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StreakCalendar } from '@/components/profile/StreakCalendar';
import { useUsageTimeseries } from './hooks';

/**
 * Reproduces the "daily coding streak" card from the old /usage page using the
 * new rollup-backed timeseries. Always shows the past 12 weeks in daily
 * granularity for a single user.
 */
export function StreakCard() {
  // We want the last 84 days of request counts at daily granularity.
  // Since the hook takes ISO date-times, compute the range here.
  const { startDate, endDate } = useMemo(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 84);
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  }, []);

  const { data, isLoading } = useUsageTimeseries({
    organizationId: null,
    dateRange: { startDate, endDate },
    granularity: 'day',
    filters: {
      features: [],
      excludedFeatures: [],
      models: [],
      excludedModels: [],
      modes: [],
      excludedModes: [],
      userIds: [],
      excludedUserIds: [],
      providers: [],
      excludedProviders: [],
      projects: [],
      excludedProjects: [],
    },
    // Streak covers activity across personal + orgs — matches old streak behavior
    personalScope: 'include-orgs',
    metric: 'requests',
  });

  const { streakData, currentStreak } = useMemo(() => {
    const dateToCount = new Map<string, number>();
    for (const pt of data?.timeseries ?? []) {
      // datetime is a date string like "2026-04-18"
      const key = pt.datetime.slice(0, 10);
      dateToCount.set(key, (dateToCount.get(key) ?? 0) + (pt.value || 0));
    }

    // Build 84-day array. The "today" anchor is intentionally a UTC date
    // (via `toISOString().slice(0,10)`) to match the UTC calendar-day keys
    // produced by the rollup and sent back on `pt.datetime`. Do not switch
    // this to local time — it would desync the streak from the bucket keys
    // for any viewer not on UTC.
    const buckets: { date: string; count: number }[] = [];
    const today = new Date();
    for (let i = 83; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      buckets.push({ date: key, count: dateToCount.get(key) ?? 0 });
    }

    // Current streak: consecutive days with count > 0 from today backwards
    let streak = 0;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (buckets[i].count > 0) streak++;
      else break;
    }
    return { streakData: buckets, currentStreak: streak };
  }, [data]);

  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col justify-center py-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-6 w-32" />
          </div>
        ) : (
          <>
            <StreakCalendar streakData={streakData} currentStreak={currentStreak} />
            <div className="mt-3 text-center">
              <div className="text-muted-foreground text-xs">Daily Coding Streak</div>
              <div className="text-2xl font-bold">
                {currentStreak} {currentStreak === 1 ? 'day' : 'days'}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
