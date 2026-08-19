'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { RevenueKpiData } from '@/lib/revenueKpi';
import { formatDollars } from '@/lib/utils';
import { format, parseISO } from 'date-fns';

type ApiResponse = {
  data: RevenueKpiData[];
};

type NumericKey = Exclude<keyof RevenueKpiData, 'transaction_day'>;

function sumKey(data: RevenueKpiData[], key: NumericKey): number {
  return data.reduce((sum, item) => sum + item[key], 0);
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
                <CreditRow
                  label={`Latest day (${latestDay})`}
                  value={key => latestData[key]}
                  countDecimals={false}
                />
                <CreditRow
                  label={`Total (${data.length} ${data.length === 1 ? 'day' : 'days'})`}
                  value={totals}
                  countDecimals={false}
                />
                <CreditRow label="Average per day" value={averages} countDecimals />
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            These credit-transaction figures keep their existing semantics, including no refund or
            dispute adjustment.
          </p>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Service fees (settled date, UTC)</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-muted-foreground py-2 pr-3 text-left font-medium">Period</th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">
                    Collected Fees
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
                    Charged
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right font-medium">Missed</th>
                  <th className="text-muted-foreground py-2 pl-3 text-right font-medium">Exempt</th>
                </tr>
              </thead>
              <tbody>
                <FeeRow
                  label={`Latest day (${latestDay} UTC)`}
                  value={key => latestData[key]}
                  countDecimals={false}
                />
                <FeeRow
                  label={`Total (${data.length} ${data.length === 1 ? 'day' : 'days'})`}
                  value={totals}
                  countDecimals={false}
                />
                <FeeRow label="Average per day" value={averages} countDecimals />
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Fee figures include settled assessments only. They do not make this dashboard a complete
            Stripe product-revenue report; Kilo Pass product revenue is not added here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

type RowProps = {
  label: string;
  value: (key: NumericKey) => number;
  countDecimals: boolean;
};

function formatCount(value: number, decimals: boolean): string | number {
  return decimals ? value.toFixed(1) : value;
}

function CreditRow({ label, value, countDecimals }: RowProps) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-3">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('paid_total_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('free_total_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('multiplied_total_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('unmultiplied_total_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatCount(value('paid_transaction_count'), countDecimals)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatCount(value('free_transaction_count'), countDecimals)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatCount(value('multiplied_transaction_count'), countDecimals)}
      </td>
      <td className="py-2 pl-3 text-right tabular-nums">
        {formatCount(value('unmultiplied_transaction_count'), countDecimals)}
      </td>
    </tr>
  );
}

function FeeRow({ label, value, countDecimals }: RowProps) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-3">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('collected_service_fee_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('missed_service_fee_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('exempted_service_fee_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatDollars(value('disputed_service_fee_dollars'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatCount(value('service_fee_charged_count'), countDecimals)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatCount(value('service_fee_missed_count'), countDecimals)}
      </td>
      <td className="py-2 pl-3 text-right tabular-nums">
        {formatCount(value('service_fee_exempt_count'), countDecimals)}
      </td>
    </tr>
  );
}
