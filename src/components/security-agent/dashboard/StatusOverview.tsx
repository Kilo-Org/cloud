'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useRouter } from 'next/navigation';

type StatusOverviewProps = {
  status: { open: number; fixed: number; ignored: number };
  isLoading: boolean;
  basePath: string;
  extraParams?: string;
};

const statusConfig = [
  {
    key: 'open',
    label: 'Open',
    color: '#eab308',
    textClass: 'text-yellow-400',
    dotClass: 'bg-yellow-400',
  },
  {
    key: 'fixed',
    label: 'Fixed',
    color: '#22c55e',
    textClass: 'text-green-400',
    dotClass: 'bg-green-400',
  },
  {
    key: 'ignored',
    label: 'Ignored',
    color: '#6b7280',
    textClass: 'text-gray-400',
    dotClass: 'bg-gray-400',
  },
] as const;

type StatusKey = (typeof statusConfig)[number]['key'];

export function StatusOverview({
  status,
  isLoading,
  basePath,
  extraParams = '',
}: StatusOverviewProps) {
  const router = useRouter();
  const total = status.open + status.fixed + status.ignored;

  const data = statusConfig
    .filter(s => status[s.key] > 0)
    .map(s => ({ name: s.label, value: status[s.key], color: s.color, key: s.key }));

  const handleClick = (statusKey: StatusKey) => {
    router.push(`${basePath}/findings?status=${statusKey}${extraParams}`);
  };

  return (
    <Card className="border border-gray-800 bg-gray-900/50">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Finding Status</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex flex-col items-center gap-4">
            <Skeleton className="h-40 w-40 rounded-full" />
            <div className="flex gap-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
        ) : total === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center py-8 text-sm">
            No findings
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="relative h-44 w-44">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={75}
                    paddingAngle={2}
                    dataKey="value"
                    strokeWidth={0}
                    onClick={(_, index) => {
                      const entry = data[index];
                      if (entry) {
                        handleClick(entry.key);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    {data.map(entry => (
                      <Cell key={entry.key} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                    itemStyle={{ color: '#e5e7eb' }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold text-white">{total}</span>
                <span className="text-muted-foreground text-xs">Total</span>
              </div>
            </div>
            <div className="flex flex-wrap justify-center gap-4">
              {statusConfig.map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => handleClick(s.key)}
                  className="flex items-center gap-1.5 text-sm hover:opacity-80"
                >
                  <span className={cn('h-2.5 w-2.5 rounded-full', s.dotClass)} />
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="text-muted-foreground">({status[s.key]})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
