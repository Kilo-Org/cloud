'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { RevenueKpiData } from '@/lib/revenueKpi';
import { formatDollars } from '@/lib/utils';
import { parseISO, format } from 'date-fns';

type ApiResponse = {
  data: RevenueKpiData[];
};

type NumericKey = Exclude<keyof RevenueKpiData, 'transaction_day'>;

function sumKey(data: RevenueKpiData[], key: NumericKey): number {
  return data.reduce((acc, item) => acc + item[key], 0);
}

export function RevenueStats({ data }: ApiResponse) {
  if (data.length === 0) {
    return (
      <Card>
        <CardContent>
          <p className="text-muted-foreground py-4 text-sm">No revenue data for this range.</p>
        </CardContent>
      </Card>
    );
  }

  const latestData = data[data.length - 1];
  const latestDay = format(parseISO(latestData.transaction_day), 'yyyy-MM-dd');

  const totals = (key: NumericKey) => sumKey(data, key);
  const averages = (key: NumericKey) => sumKey(data, key) / data.length;

  return (
    <Card>
      <CardContent className="space-y-6">
        <div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground py-2 pr-3 text-left font-medium">Period</th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Legacy Gross
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Free Credits
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Multiplied Legacy Gross
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Unmultiplied Legacy Gross
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Paid Tx
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Free Tx
                  </th>
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
                  <td className="py-2 pr-3">Latest day ({latestDay})</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.paid_total_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.free_total_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.multiplied_total_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.unmultiplied_total_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {latestData.paid_transaction_count}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {latestData.free_transaction_count}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {latestData.multiplied_transaction_count}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {latestData.unmultiplied_transaction_count}
                  </td>
                </tr>

                <tr className="border-b">
                  <td className="py-2 pr-3">
                    Total ({data.length} {data.length === 1 ? 'day' : 'days'})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('paid_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('free_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('multiplied_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('unmultiplied_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totals('paid_transaction_count')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totals('free_transaction_count')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totals('multiplied_transaction_count')}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {totals('unmultiplied_transaction_count')}
                  </td>
                </tr>

                <tr>
                  <td className="py-2 pr-3">Average per day</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('paid_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('free_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('multiplied_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('unmultiplied_total_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {averages('paid_transaction_count').toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {averages('free_transaction_count').toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {averages('multiplied_transaction_count').toFixed(1)}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {averages('unmultiplied_transaction_count').toFixed(1)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Legacy gross is the raw credit-transaction total with no refund or dispute adjustment.
            Top-ups with a settled service fee assessment are excluded here and reported as net
            assessment rows below.
          </p>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Net assessment rows (settled date, UTC)</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground py-2 pr-3 text-left font-medium">Period</th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Product Revenue
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Service Fees
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Gross Revenue
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Missed Fees
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Exempted Fees
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Disputed Fees
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Collected
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">Missed</th>
                  <th className="text-muted-foreground py-2 pl-3 text-right font-medium">Exempt</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="py-2 pr-3">Latest day ({latestDay} UTC)</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.product_revenue_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.collected_service_fee_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.gross_revenue_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.missed_service_fee_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.exempted_service_fee_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(latestData.disputed_service_fee_dollars)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {latestData.service_fee_collected_count}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {latestData.service_fee_missed_count}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {latestData.service_fee_exempt_count}
                  </td>
                </tr>

                <tr className="border-b">
                  <td className="py-2 pr-3">
                    Total ({data.length} {data.length === 1 ? 'day' : 'days'})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('product_revenue_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('collected_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('gross_revenue_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('missed_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('exempted_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(totals('disputed_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totals('service_fee_collected_count')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totals('service_fee_missed_count')}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {totals('service_fee_exempt_count')}
                  </td>
                </tr>

                <tr>
                  <td className="py-2 pr-3">Average per day</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('product_revenue_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('collected_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('gross_revenue_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('missed_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('exempted_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDollars(averages('disputed_service_fee_dollars'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {averages('service_fee_collected_count').toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {averages('service_fee_missed_count').toFixed(1)}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {averages('service_fee_exempt_count').toFixed(1)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Net assessment rows are settled service fee assessments net of refunds and disputes,
            grouped by settled date (UTC). They include New Kilo Pass revenue, which the legacy
            series never contained, so the two tables do not reconcile row-for-row. Missed and
            exempted fees are the expected fee on settled payments where no fee was collected;
            disputed fees are the fee portion withdrawn by chargebacks.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
