'use client';
import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

type UserScore = {
  frequency: number;
  depth: number;
  coverage: number;
  total: number;
};

type AIAdoptionDistributionProps = {
  userScores: UserScore[];
  isLoading?: boolean;
};

export function AIAdoptionDistribution({ userScores, isLoading }: AIAdoptionDistributionProps) {
  // Create histogram buckets in 5% increments
  const histogramData = useMemo(() => {
    if (!userScores || userScores.length === 0) return [];

    // Create 20 buckets (0-5, 5-10, ..., 95-100)
    const buckets: Array<{
      range: string;
      min: number;
      max: number;
      count: number;
      color: string;
    }> = [];
    for (let i = 0; i < 100; i += 5) {
      // Color gradient from red to green
      let color;
      if (i < 20)
        color = '#ef4444'; // red
      else if (i < 40)
        color = '#f59e0b'; // orange
      else if (i < 60)
        color = '#3b82f6'; // blue
      else if (i < 80)
        color = '#10b981'; // green
      else color = '#22c55e'; // bright green

      buckets.push({
        range: `${i}-${i + 5}`,
        min: i,
        max: i + 5,
        count: 0,
        color,
      });
    }

    userScores.forEach(user => {
      const bucketIndex = Math.min(Math.floor(user.total / 5), 19);
      if (buckets[bucketIndex]) {
        buckets[bucketIndex].count++;
      }
    });

    return buckets;
  }, [userScores]);

  // Custom tooltip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;

    const data = payload[0]?.payload;

    return (
      <div
        className="rounded-lg border border-gray-700 p-3 shadow-lg backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <p className="mb-1 text-xs font-medium text-gray-400">Score Range: {data?.range}%</p>
        <p className="text-sm font-bold text-gray-100">
          {data?.count} {data?.count === 1 ? 'user' : 'users'}
        </p>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-full w-full animate-pulse rounded bg-gray-700" />
      </div>
    );
  }

  if (!userScores || userScores.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground text-sm">No user data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Histogram */}
      <Card>
        <CardContent className="pt-6">
          <div className="relative h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogramData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey="range"
                  stroke="#a1a1a1"
                  tick={{ fontSize: 11 }}
                  label={{
                    value: 'Score Range (%)',
                    position: 'insideBottom',
                    offset: -5,
                    fontSize: 11,
                    fill: '#a1a1a1',
                  }}
                />
                <YAxis
                  stroke="#a1a1a1"
                  tick={{ fontSize: 11 }}
                  width={40}
                  label={{
                    value: 'Number of Users',
                    angle: -90,
                    position: 'insideLeft',
                    fontSize: 11,
                    fill: '#a1a1a1',
                  }}
                  allowDecimals={false}
                />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {histogramData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* User List */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <h3 className="mb-3 text-sm font-medium text-gray-400">Individual User Scores</h3>
            <div className="max-h-96 space-y-2 overflow-y-auto">
              {userScores
                .sort((a, b) => b.total - a.total)
                .map((user, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/50 p-3"
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-300">User #{index + 1}</p>
                      <div className="mt-1 flex gap-3 text-xs text-gray-400">
                        <span>Frequency: {user.frequency}</span>
                        <span>Depth: {user.depth}</span>
                        <span>Coverage: {user.coverage}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold">{user.total}%</p>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
