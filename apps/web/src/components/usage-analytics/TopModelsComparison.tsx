'use client';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UsageBreakdown } from './types';
import { formatDollarsFromMicrodollars } from './format';

type TopModelsComparisonProps = {
  cost: UsageBreakdown | undefined;
  requests: UsageBreakdown | undefined;
  loading: boolean;
};

/**
 * Side-by-side comparison of top models by cost and request volume.
 *
 * Latency / error rate per model would require a separate breakdown that is
 * not currently supported by `getBreakdown` (which returns a single metric).
 * We leave them out for now to keep the API surface narrow.
 */
export function TopModelsComparison({ cost, requests, loading }: TopModelsComparisonProps) {
  const chartData = useMemo(() => {
    const byModel = new Map<string, { name: string; costUsd: number; requests: number }>();
    for (const c of cost?.breakdown ?? []) {
      const existing = byModel.get(c.key) ?? { name: c.key, costUsd: 0, requests: 0 };
      existing.costUsd = c.value / 1_000_000;
      byModel.set(c.key, existing);
    }
    for (const r of requests?.breakdown ?? []) {
      const existing = byModel.get(r.key) ?? { name: r.key, costUsd: 0, requests: 0 };
      existing.requests = r.value;
      byModel.set(r.key, existing);
    }
    return Array.from(byModel.values())
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 10);
  }, [cost, requests]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Top Models — Cost vs Requests</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <div className="h-72 w-full">
          {loading ? (
            <div className="bg-muted/20 h-full w-full animate-pulse rounded" />
          ) : chartData.length === 0 ? (
            <div className="text-muted-foreground flex h-full items-center justify-center">
              No data.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" stroke="currentColor" fontSize={11} />
                <YAxis
                  dataKey="name"
                  type="category"
                  stroke="currentColor"
                  fontSize={11}
                  width={140}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(17, 24, 39, 0.95)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(value, name) => {
                    const n = Number(value);
                    if (name === 'Cost') {
                      return [formatDollarsFromMicrodollars(n * 1_000_000), String(name)];
                    }
                    return [Math.round(n).toLocaleString(), String(name)];
                  }}
                />
                <Legend />
                <Bar dataKey="costUsd" name="Cost" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                <Bar dataKey="requests" name="Requests" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
