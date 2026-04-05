'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { RevenueKpiData } from '@/lib/revenueKpi';
import { formatDollars } from '@/lib/utils';
import { parseISO, format } from 'date-fns';

type ApiResponse = {
  data: RevenueKpiData[];
};

export function RevenueStats({ data }: ApiResponse) {
  const latestData = data[data.length - 1];

  const totals = data.reduce(
    (acc, item) => ({
      paid_total_dollars: acc.paid_total_dollars + item.paid_total_dollars,
      free_total_dollars: acc.free_total_dollars + item.free_total_dollars,
      multiplied_total_dollars: acc.multiplied_total_dollars + item.multiplied_total_dollars,
      unmultiplied_total_dollars: acc.unmultiplied_total_dollars + item.unmultiplied_total_dollars,
      paid_transaction_count: acc.paid_transaction_count + item.paid_transaction_count,
      free_transaction_count: acc.free_transaction_count + item.free_transaction_count,
      multiplied_transaction_count:
        acc.multiplied_transaction_count + item.multiplied_transaction_count,
      unmultiplied_transaction_count:
        acc.unmultiplied_transaction_count + item.unmultiplied_transaction_count,
    }),
    {
      paid_total_dollars: 0,
      free_total_dollars: 0,
      multiplied_total_dollars: 0,
      unmultiplied_total_dollars: 0,
      paid_transaction_count: 0,
      free_transaction_count: 0,
      multiplied_transaction_count: 0,
      unmultiplied_transaction_count: 0,
    }
  );

  const averages =
    data.length > 0
      ? {
          paid_total_dollars: totals.paid_total_dollars / data.length,
          free_total_dollars: totals.free_total_dollars / data.length,
          multiplied_total_dollars: totals.multiplied_total_dollars / data.length,
          unmultiplied_total_dollars: totals.unmultiplied_total_dollars / data.length,
          paid_transaction_count: totals.paid_transaction_count / data.length,
          free_transaction_count: totals.free_transaction_count / data.length,
          multiplied_transaction_count: totals.multiplied_transaction_count / data.length,
          unmultiplied_transaction_count: totals.unmultiplied_transaction_count / data.length,
        }
      : {
          paid_total_dollars: 0,
          free_total_dollars: 0,
          multiplied_total_dollars: 0,
          unmultiplied_total_dollars: 0,
          paid_transaction_count: 0,
          free_transaction_count: 0,
          multiplied_transaction_count: 0,
          unmultiplied_transaction_count: 0,
        };

  return (
    <Card>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-muted-foreground py-2 pr-3 text-left font-medium">Period</th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                  Paid Revenue
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                  Free Credits
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                  Multiplied Revenue
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                  Unmultiplied Revenue
                </th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">Paid Tx</th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">Free Tx</th>
                <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                  Multiplied Tx
                </th>
                <th className="text-muted-foreground py-2 pl-3 text-right font-medium">
                  Unmultiplied Tx
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="py-2 pr-3">
                  Latest day ({format(parseISO(latestData.transaction_day), 'yyyy-MM-dd')})
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(latestData.paid_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(latestData.free_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(latestData.multiplied_total_dollars ?? 0)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(latestData.unmultiplied_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">{latestData.paid_transaction_count}</td>
                <td className="px-3 py-2 text-right">{latestData.free_transaction_count}</td>
                <td className="px-3 py-2 text-right">
                  {latestData.multiplied_transaction_count ?? 0}
                </td>
                <td className="py-2 pl-3 text-right">
                  {latestData.unmultiplied_transaction_count}
                </td>
              </tr>

              <tr className="border-b">
                <td className="py-2 pr-3">
                  Total ({data.length} {data.length === 1 ? 'day' : 'days'})
                </td>
                <td className="px-3 py-2 text-right">{formatDollars(totals.paid_total_dollars)}</td>
                <td className="px-3 py-2 text-right">{formatDollars(totals.free_total_dollars)}</td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(totals.multiplied_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(totals.unmultiplied_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">{totals.paid_transaction_count}</td>
                <td className="px-3 py-2 text-right">{totals.free_transaction_count}</td>
                <td className="px-3 py-2 text-right">{totals.multiplied_transaction_count}</td>
                <td className="py-2 pl-3 text-right">{totals.unmultiplied_transaction_count}</td>
              </tr>

              <tr>
                <td className="py-2 pr-3">Average per day</td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(averages.paid_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(averages.free_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(averages.multiplied_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatDollars(averages.unmultiplied_total_dollars)}
                </td>
                <td className="px-3 py-2 text-right">
                  {averages.paid_transaction_count.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-right">
                  {averages.free_transaction_count.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-right">
                  {averages.multiplied_transaction_count.toFixed(1)}
                </td>
                <td className="py-2 pl-3 text-right">
                  {averages.unmultiplied_transaction_count.toFixed(1)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
