'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FeatureInterestTimelineEntry } from '@/routers/admin-feature-interest-router';
import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { HelpCircle } from 'lucide-react';

type FeatureInterestTimelineProps = {
  timeline: FeatureInterestTimelineEntry[];
  query?: string;
};

export function FeatureInterestTimeline({ timeline, query }: FeatureInterestTimelineProps) {
  const [showQuery, setShowQuery] = useState(false);

  // Group timeline data by week
  const groupedByWeek = useMemo(() => {
    const grouped = new Map<string, Map<string, number>>();
    const allFeatures = new Set<string>();

    for (const entry of timeline) {
      allFeatures.add(entry.feature);
      let weekMap = grouped.get(entry.week_start);
      if (!weekMap) {
        weekMap = new Map();
        grouped.set(entry.week_start, weekMap);
      }
      weekMap.set(entry.feature, entry.signups);
    }

    return { grouped, allFeatures: Array.from(allFeatures).sort() };
  }, [timeline]);

  // Get sorted weeks
  const sortedWeeks = useMemo(() => {
    return Array.from(groupedByWeek.grouped.keys()).sort();
  }, [groupedByWeek]);

  // Calculate totals per feature
  const featureTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const entry of timeline) {
      totals.set(entry.feature, (totals.get(entry.feature) ?? 0) + entry.signups);
    }
    return totals;
  }, [timeline]);

  // Sort features by total signups (descending)
  const sortedFeatures = useMemo(() => {
    return groupedByWeek.allFeatures.sort((a, b) => {
      return (featureTotals.get(b) ?? 0) - (featureTotals.get(a) ?? 0);
    });
  }, [groupedByWeek.allFeatures, featureTotals]);

  if (timeline.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Feature Interest Over Time</CardTitle>
          <p className="text-muted-foreground text-sm">Weekly signup trends</p>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground py-4 text-center">No timeline data available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Feature Interest Over Time</CardTitle>
            <p className="text-muted-foreground text-sm">Weekly unique signups per feature</p>
          </div>
          {query && (
            <button
              onClick={() => setShowQuery(!showQuery)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Show PostHog query"
            >
              <HelpCircle className="h-5 w-5" />
            </button>
          )}
        </div>
        {showQuery && query && (
          <pre className="bg-muted mt-3 overflow-x-auto rounded-md p-3 text-xs">
            <code>{query.trim()}</code>
          </pre>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-muted-foreground bg-background sticky left-0 py-2 pr-3 text-left font-medium">
                  Week
                </th>
                {sortedFeatures.map(feature => (
                  <th
                    key={feature}
                    className="text-muted-foreground px-2 py-2 text-right font-medium whitespace-nowrap"
                    title={feature}
                  >
                    {feature.length > 15 ? `${feature.slice(0, 15)}...` : feature}
                  </th>
                ))}
                <th className="text-muted-foreground py-2 pl-3 text-right font-medium">
                  Weekly Total
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedWeeks.map(week => {
                const weekData = groupedByWeek.grouped.get(week);
                if (!weekData) return null;
                const weeklyTotal = Array.from(weekData.values()).reduce((sum, v) => sum + v, 0);

                return (
                  <tr key={week} className="hover:bg-muted/50 border-b">
                    <td className="bg-background sticky left-0 py-2 pr-3 whitespace-nowrap">
                      {format(parseISO(week), 'MMM d')}
                    </td>
                    {sortedFeatures.map(feature => {
                      const value = weekData.get(feature) ?? 0;
                      return (
                        <td
                          key={feature}
                          className={`px-2 py-2 text-right ${value > 0 ? 'font-medium' : 'text-muted-foreground'}`}
                        >
                          {value > 0 ? value : '-'}
                        </td>
                      );
                    })}
                    <td className="py-2 pl-3 text-right font-medium">{weeklyTotal}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-medium">
                <td className="bg-background sticky left-0 py-2 pr-3">Total</td>
                {sortedFeatures.map(feature => (
                  <td key={feature} className="px-2 py-2 text-right">
                    {featureTotals.get(feature) ?? 0}
                  </td>
                ))}
                <td className="py-2 pl-3 text-right">
                  {Array.from(featureTotals.values()).reduce((sum, v) => sum + v, 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
