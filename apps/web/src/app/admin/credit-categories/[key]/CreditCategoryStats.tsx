'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  GuiCreditCategoryStatistics,
  CreditCategoriesApiResponse,
} from '@/lib/PromoCreditCategoryConfig';

interface CreditCategoryStatsProps {
  creditCategoryKey: string;
}

const fetchCreditCategoryStats = async (
  creditCategoryKey: string
): Promise<GuiCreditCategoryStatistics | null> => {
  const response = await fetch(
    `/admin/api/credit-categories?key=${encodeURIComponent(creditCategoryKey)}`
  );
  const data: CreditCategoriesApiResponse = await response.json();

  return data.creditCategories.length === 1 ? data.creditCategories[0] : null;
};

export function CreditCategoryStats({ creditCategoryKey }: CreditCategoryStatsProps) {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['credit-category-stats', creditCategoryKey],
    queryFn: () => fetchCreditCategoryStats(creditCategoryKey),
  });

  const valueClassName = isLoading ? 'bg-muted h-6 animate-pulse rounded' : 'text-2xl font-bold';

  return (
    <div>
      <h2 className="text-xl font-semibold">Credit category usage statistics</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Total Users</p>
          <p className={valueClassName}>{stats?.user_count.toLocaleString()}</p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Total Credits</p>
          <p className={valueClassName}>{stats?.credit_count.toLocaleString()}</p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Total Dollars</p>
          <p className={valueClassName}>${stats?.total_dollars.toFixed(2)}</p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Users (7d)</p>
          <p className={valueClassName}>{stats?.user_count_last_week.toLocaleString()}</p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Credits (7d)</p>
          <p className={valueClassName}>{stats?.credit_count_last_week.toLocaleString()}</p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Dollars (7d)</p>
          <p className={valueClassName}>${stats?.total_dollars_last_week.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}
