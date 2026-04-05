'use client';
import { useMemo } from 'react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import styles from './BackgroundChart.module.css';

type Props = {
  data: [number[], number[]];
  color?: string;
  className?: string;
};

export function BackgroundChart({ data, color = '#3b82f6', className = '' }: Props) {
  // Convert data from [number[], number[]] format to recharts format
  const chartData = useMemo(() => {
    const [xData, yData] = data;
    let points = xData.map((x, i) => ({
      x,
      y: yData[i] ?? null,
    }));

    // Sample data to max 20 points for performance (background chart preset behavior)
    const maxDataPoints = 20;
    if (points.length > maxDataPoints) {
      const step = Math.ceil(points.length / maxDataPoints);
      points = points.filter((_, i) => i % step === 0 || i === points.length - 1);
    }

    return points;
  }, [data]);

  return (
    <div className={`${styles['card-chart']} ${className}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 0, bottom: 0, left: 0 }}>
          <Area
            type="monotone"
            dataKey="y"
            stroke={`${color}40`}
            fill={`${color}10`}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
