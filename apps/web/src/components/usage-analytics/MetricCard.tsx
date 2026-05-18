'use client';
import type { ReactNode, ComponentType } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { BackgroundChart } from '@/components/organizations/usage-details/BackgroundChart';

type MetricCardProps = {
  title: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  sparkline?: [number[], number[]];
  color?: string;
  loading?: boolean;
  selected?: boolean;
  onClick?: () => void;
  subtext?: ReactNode;
  className?: string;
};

export function MetricCard({
  title,
  value,
  icon: IconComponent,
  sparkline,
  color = '#3b82f6',
  loading,
  selected,
  onClick,
  subtext,
  className,
}: MetricCardProps) {
  const clickable = !!onClick;
  return (
    <Card
      className={cn(
        'relative overflow-hidden transition-all duration-200',
        clickable && 'cursor-pointer hover:shadow-md',
        selected
          ? 'bg-blue-950/20 shadow-md ring-2 ring-blue-500'
          : clickable
            ? 'hover:bg-gray-900/20'
            : '',
        className
      )}
      onClick={onClick}
    >
      {sparkline && (
        <BackgroundChart
          data={sparkline}
          color={color}
          className={cn('transition-opacity duration-200', selected ? 'opacity-100' : 'opacity-80')}
        />
      )}
      <CardHeader className="relative z-[1] flex flex-row items-center space-y-0 px-3 pt-2 pb-0.5">
        {IconComponent && <IconComponent className="mr-2 h-4 w-4" />}
        <CardTitle className="text-sm font-medium whitespace-nowrap">{title}</CardTitle>
      </CardHeader>
      <CardContent className="relative z-[1] px-3 pb-2">
        <div
          className={cn(
            'text-xl font-bold transition-colors duration-200',
            selected ? 'text-blue-300' : ''
          )}
        >
          {loading ? <Skeleton className="h-7 w-20" /> : value}
        </div>
        {subtext && <div className="text-muted-foreground mt-1 text-xs">{subtext}</div>}
      </CardContent>
    </Card>
  );
}
