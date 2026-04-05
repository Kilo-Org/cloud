'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, XCircle, Shield, AlertCircle } from 'lucide-react';

type SecurityStatsSummaryProps = {
  stats: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    open: number;
    fixed: number;
    ignored: number;
  };
  isLoading?: boolean;
};

type StatCardProps = {
  label: string;
  value: number;
  icon: React.ReactNode;
  iconBgColor: string;
  iconColor: string;
  valueColor: string;
  isLoading?: boolean;
};

function StatCard({
  label,
  value,
  icon,
  iconBgColor,
  iconColor,
  valueColor,
  isLoading,
}: StatCardProps) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50 p-4 transition-all hover:border-gray-700 hover:bg-gray-900/70">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', iconBgColor)}>
          <div className={iconColor}>{icon}</div>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground text-sm font-medium">{label}</span>
          {isLoading ? (
            <Skeleton className="mt-1 h-7 w-12" />
          ) : (
            <span className={cn('text-2xl font-bold', valueColor)}>{value}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SecurityStatsSummary({ stats, isLoading }: SecurityStatsSummaryProps) {
  return (
    <div className="space-y-4">
      {/* Severity Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Critical"
          value={stats.critical}
          icon={<AlertCircle className="h-5 w-5" />}
          iconBgColor="bg-red-500/20"
          iconColor="text-red-400"
          valueColor="text-red-400"
          isLoading={isLoading}
        />
        <StatCard
          label="High"
          value={stats.high}
          icon={<AlertTriangle className="h-5 w-5" />}
          iconBgColor="bg-orange-500/20"
          iconColor="text-orange-400"
          valueColor="text-orange-400"
          isLoading={isLoading}
        />
        <StatCard
          label="Medium"
          value={stats.medium}
          icon={<Shield className="h-5 w-5" />}
          iconBgColor="bg-yellow-500/20"
          iconColor="text-yellow-400"
          valueColor="text-yellow-400"
          isLoading={isLoading}
        />
        <StatCard
          label="Low"
          value={stats.low}
          icon={<Shield className="h-5 w-5" />}
          iconBgColor="bg-blue-500/20"
          iconColor="text-blue-400"
          valueColor="text-blue-400"
          isLoading={isLoading}
        />
      </div>

      {/* Status Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Open"
          value={stats.open}
          icon={<AlertTriangle className="h-5 w-5" />}
          iconBgColor="bg-yellow-500/20"
          iconColor="text-yellow-400"
          valueColor="text-yellow-400"
          isLoading={isLoading}
        />
        <StatCard
          label="Fixed"
          value={stats.fixed}
          icon={<CheckCircle2 className="h-5 w-5" />}
          iconBgColor="bg-green-500/20"
          iconColor="text-green-400"
          valueColor="text-green-400"
          isLoading={isLoading}
        />
        <StatCard
          label="Ignored"
          value={stats.ignored}
          icon={<XCircle className="h-5 w-5" />}
          iconBgColor="bg-gray-500/20"
          iconColor="text-gray-400"
          valueColor="text-gray-400"
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}
