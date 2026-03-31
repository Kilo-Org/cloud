'use client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BackgroundChart } from './BackgroundChart';
import { cn } from '@/lib/utils';

type Metric = {
  key: string;
  title: string;
  value: string | React.ReactNode;
  chartType: 'line' | 'bar';
  data: [number[], number[]];
  icon?: React.ComponentType<{ className?: string }>;
  color?: string;
  loading?: boolean;
};

type Props = {
  metrics: Metric[];
  selectedMetric: string;
  onSelectedMetricChange: (selectedMetric: string) => void;
};

export function MetricSelector({ metrics, selectedMetric, onSelectedMetricChange }: Props) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      {metrics.map(metric => {
        const isSelected = metric.key === selectedMetric;
        const IconComponent = metric.icon;

        return (
          <Card
            key={metric.key}
            className={cn(
              'relative cursor-pointer overflow-hidden transition-all duration-200 hover:shadow-md',
              isSelected ? 'bg-blue-950/20 shadow-md ring-2 ring-blue-500' : 'hover:bg-gray-900/20'
            )}
            onClick={() => onSelectedMetricChange(metric.key)}
          >
            <BackgroundChart
              data={metric.data}
              color={metric.color || '#3b82f6'}
              className={cn(
                'transition-opacity duration-200',
                isSelected ? 'opacity-100' : 'opacity-80'
              )}
            />
            <CardHeader className="relative z-[1] flex flex-row items-center space-y-0 px-3 pt-2 pb-0.5">
              {IconComponent && <IconComponent className="mr-2 h-4 w-4" />}
              <CardTitle className="text-sm font-medium whitespace-nowrap">
                {metric.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="relative z-[1] px-3 pb-2">
              <div
                className={cn(
                  'text-xl font-bold transition-colors duration-200',
                  isSelected ? 'text-blue-300' : ''
                )}
              >
                {metric.loading ? (
                  <div className="h-8 w-full animate-pulse rounded bg-gray-700" />
                ) : (
                  metric.value
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
