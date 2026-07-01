'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

export type StatusChartDatum = {
  label: string;
  value: number;
  color: string;
};

export function StatusDonutChart({
  data,
  totalLabel,
}: {
  data: StatusChartDatum[];
  totalLabel: string;
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative h-36 w-full sm:w-44 sm:shrink-0" role="img" aria-label={totalLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={42}
              outerRadius={62}
              paddingAngle={total > 0 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map(item => (
                <Cell key={item.label} fill={item.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--popover)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                fontSize: 12,
              }}
              formatter={value => [Number(value), 'Count']}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold tabular-nums">{total}</span>
          <span className="text-muted-foreground type-label">total</span>
        </div>
      </div>
      <div className="grid flex-1 gap-2">
        {data.map(item => (
          <div key={item.label} className="flex items-center gap-2 text-sm">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-medium tabular-nums">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
