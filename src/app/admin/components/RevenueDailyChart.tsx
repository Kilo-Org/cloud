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
import type { RevenueKpiData } from '@/lib/revenueKpi';
import { formatDollars } from '@/lib/utils';

type ApiResponse = {
  data: RevenueKpiData[];
  showFreeCredits: boolean;
};

export function RevenueDailyChart({ data, showFreeCredits }: ApiResponse) {
  const downloadData = () => {
    if (data.length === 0) return;

    // Derive headers from the actual data - completely type-safe and always complete!
    const headers = Object.keys(data[0]) as (keyof RevenueKpiData)[];

    const csvRows = [
      headers.join(','),
      ...data.map(row => headers.map(header => row[header] ?? 0).join(',')),
    ];

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `revenue-data-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Transform data for the chart
  const chartData = data.map(item => {
    const paidRevenue = item.paid_total_dollars;
    const freeCredits = item.free_total_dollars;
    const totalCredits = paidRevenue + freeCredits;
    const paidPercentage = totalCredits > 0 ? (paidRevenue / totalCredits) * 100 : 0;

    return {
      day: format(parseISO(item.transaction_day), 'MM/dd'),
      paidRevenue: paidRevenue,
      freeCredits: freeCredits,
      multipliedRevenue: item.multiplied_total_dollars || 0,
      unmultipliedRevenue: item.unmultiplied_total_dollars,
      paidPercentage: paidPercentage,
    };
  });

  // Custom tooltip with type-safe access to raw data
  type ChartDataPoint = {
    day: string;
    paidRevenue: number;
    freeCredits: number;
    multipliedRevenue: number;
    unmultipliedRevenue: number;
    paidPercentage: number;
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

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (active && payload && payload.length > 0) {
      // Access the raw data object directly - much more type-safe!
      const data = payload[0]?.payload;

      if (!data) return null;

      return (
        <div className="bg-background rounded-lg border p-3 shadow-sm">
          <p className="text-sm font-medium">{label}</p>
          <div className="mt-2 space-y-1">
            <p className="text-sm">
              <span className="text-muted-foreground">Paid Revenue:</span>{' '}
              <span className="font-medium">{formatDollars(data.paidRevenue)}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Free Credits:</span>{' '}
              <span className="font-medium">{formatDollars(data.freeCredits)}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Multiplied Revenue:</span>{' '}
              <span className="font-medium">{formatDollars(data.multipliedRevenue)}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Unmultiplied Revenue:</span>{' '}
              <span className="font-medium">{formatDollars(data.unmultipliedRevenue)}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Paid Credits %:</span>{' '}
              <span className="font-medium">{data.paidPercentage.toFixed(1)}%</span>
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  // Calculate dynamic Y-axis domain for better visualization
  const maxRevenue = Math.max(
    ...chartData.map(d =>
      Math.max(
        d.paidRevenue,
        showFreeCredits ? d.freeCredits : 0,
        d.multipliedRevenue,
        d.unmultipliedRevenue
      )
    )
  );
  const yAxisMax = Math.ceil(maxRevenue * 1.1); // Add 10% padding

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Daily Revenue Trend</CardTitle>
            <CardDescription>Daily breakdown of revenue metrics</CardDescription>
          </div>
          <button
            onClick={downloadData}
            className="hover:bg-background inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none"
          >
            <svg
              className="mr-2 h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            Download CSV
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 80, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="day"
                angle={-45}
                textAnchor="end"
                height={100}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis
                yAxisId="left"
                className="text-xs"
                tick={{ fontSize: 10 }}
                label={{
                  value: 'Revenue (USD)',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
                domain={[0, yAxisMax]}
                tickFormatter={value => `$${value.toFixed(0)}`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                className="text-xs"
                tick={{ fontSize: 10 }}
                label={{
                  value: 'Paid Credits (%)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12 },
                }}
                domain={[0, 100]}
                tickFormatter={value => `${value.toFixed(0)}%`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Bar
                yAxisId="left"
                dataKey="unmultipliedRevenue"
                stackId="paid"
                fill="#16a34a"
                name="Revenue Without Multipliers"
              />
              <Bar
                yAxisId="left"
                dataKey="multipliedRevenue"
                stackId="paid"
                fill="#dc2626"
                name="Revenue Due to Multipliers"
              />
              {showFreeCredits && (
                <Bar
                  yAxisId="left"
                  dataKey="freeCredits"
                  fill="#f59e0b"
                  name="Free Credits Issued"
                />
              )}
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="paidPercentage"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 2 }}
                name="Paid Credits %"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
