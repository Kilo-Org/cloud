'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { format, parseISO } from 'date-fns';

type DailyData = {
  day: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  inProgress: number;
  billingErrors: number;
};

type ChartDataPoint = {
  day: string;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  inProgress: number;
  billingErrors: number;
  total: number;
  successRate: number;
};

type TooltipPayload = {
  payload: ChartDataPoint;
  dataKey: string;
  value: number;
  name: string;
  color: string;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
};

export function CodeReviewDailyChart({ data }: { data: DailyData[] }) {
  const chartData: ChartDataPoint[] = data.map(item => ({
    day: format(parseISO(item.day), 'MM/dd'),
    completed: item.completed,
    failed: item.failed,
    cancelled: item.cancelled,
    interrupted: item.interrupted,
    inProgress: item.inProgress,
    billingErrors: item.billingErrors,
    total: item.total,
    successRate: item.total > 0 ? (item.completed / item.total) * 100 : 0,
  }));

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (active && payload && payload.length > 0) {
      const data = payload[0]?.payload;
      if (!data) return null;

      return (
        <div className="bg-background rounded-lg border p-3 shadow-sm">
          <p className="text-sm font-medium">{label}</p>
          <div className="mt-2 space-y-1">
            <p className="text-sm">
              <span className="text-muted-foreground">Total:</span>{' '}
              <span className="font-medium">{data.total}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Completed:</span>{' '}
              <span className="font-medium text-green-600">{data.completed}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Failed:</span>{' '}
              <span className="font-medium text-red-600">{data.failed}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Cancelled:</span>{' '}
              <span className="font-medium text-yellow-600">{data.cancelled}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Interrupted:</span>{' '}
              <span className="font-medium text-orange-600">{data.interrupted}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Billing Errors:</span>{' '}
              <span className="font-medium text-amber-500">{data.billingErrors}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">In Progress:</span>{' '}
              <span className="font-medium text-blue-600">{data.inProgress}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Success Rate:</span>{' '}
              <span className="font-medium">{data.successRate.toFixed(1)}%</span>
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  const maxValue = Math.max(...chartData.map(d => d.total), 1);
  const yAxisMax = Math.ceil(maxValue * 1.1);

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reviews Per Day</CardTitle>
          <CardDescription>No data available for selected period</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reviews Per Day</CardTitle>
        <CardDescription>Daily breakdown by status with success rate trend</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[350px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 80, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="day"
                angle={-45}
                textAnchor="end"
                height={80}
                tick={{ fontSize: 10 }}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 10 }}
                domain={[0, yAxisMax]}
                label={{
                  value: 'Reviews',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 10 }}
                domain={[0, 100]}
                tickFormatter={value => `${value}%`}
                label={{
                  value: 'Success Rate',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12 },
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Bar yAxisId="left" dataKey="completed" stackId="a" fill="#16a34a" name="Completed" />
              <Bar yAxisId="left" dataKey="failed" stackId="a" fill="#dc2626" name="Failed" />
              <Bar yAxisId="left" dataKey="cancelled" stackId="a" fill="#eab308" name="Cancelled" />
              <Bar
                yAxisId="left"
                dataKey="interrupted"
                stackId="a"
                fill="#ea580c"
                name="Interrupted"
              />
              <Bar
                yAxisId="left"
                dataKey="billingErrors"
                stackId="a"
                fill="#fb7185"
                name="Billing Errors"
              />
              <Bar
                yAxisId="left"
                dataKey="inProgress"
                stackId="a"
                fill="#3b82f6"
                name="In Progress"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="successRate"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ r: 2 }}
                name="Success Rate %"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
