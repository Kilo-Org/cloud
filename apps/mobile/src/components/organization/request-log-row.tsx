import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateBidiText } from '@/lib/bidi';
import { formatClockTime, formatNumber, formatPrefixedUsd, UNMEASURED_VALUE } from '@/lib/format';
import { type OrgRequestLogEntry } from '@/lib/hooks/use-org-billing-queries';
import { parseTimestamp } from '@/lib/utils';

/** The name the web table prints for a request's user, with its own fallbacks. */
export const RequestLogRow = memo(function RequestLogRow({
  entry,
}: Readonly<{ entry: OrgRequestLogEntry }>) {
  const { t } = useTranslation();
  const locale = i18n.language;
  const created = parseTimestamp(entry.created_at);
  const time = Number.isNaN(created.getTime())
    ? UNMEASURED_VALUE
    : formatClockTime(created, locale);
  // Six fraction digits, as the web table prints a request's cost: a gateway
  // request can cost less than a cent, and two digits would round it to zero.
  const cost = formatPrefixedUsd(fromMicrodollars(entry.cost_microdollars), locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  const tokens = t('organization.requestLogs.tokens', {
    input: formatNumber(entry.input_tokens, locale),
    output: formatNumber(entry.output_tokens, locale),
  });
  // The web table names a request's user by name, then email, then id, and skips
  // an empty value rather than printing a blank cell.
  const userName =
    [entry.user.name, entry.user.email, entry.user.id].find(Boolean) ?? UNMEASURED_VALUE;

  return (
    <Card className="mx-4">
      <View className="flex-row items-baseline gap-3">
        <Text variant="mono" className="flex-1" numberOfLines={1}>
          {entry.model ?? UNMEASURED_VALUE}
        </Text>
        <Text className="shrink-0 text-sm font-medium tabular-nums text-foreground">{cost}</Text>
      </View>
      <View className="flex-row items-center gap-3">
        <Text variant="caption" className="flex-1" numberOfLines={1}>
          {userName}
        </Text>
        <Text variant="caption" className="shrink-0" numberOfLines={1}>
          {entry.provider ?? UNMEASURED_VALUE}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        {/* One run, so the time and the token pair keep the catalog's own
            separators: a `gap` between two `Text`s spaced the first dot
            differently from the dot inside `in · out`. The time is isolated on
            its own so the AM/PM marker stays beside its clock in either
            direction. */}
        <Text variant="caption" className="flex-1 tabular-nums" numberOfLines={1}>
          {`${isolateBidiText(time)} · ${tokens}`}
        </Text>
        {entry.is_user_byok ? (
          // Muted text with no box: `bg-muted` is the card's own `bg-secondary`
          // in both themes, so a filled badge paints nothing, and its padding
          // pulled the marker inside the right edge that cost and provider
          // share while adding a line of height the other rows lack.
          <Text variant="caption" className="shrink-0">
            {t('organization.requestLogs.byok')}
          </Text>
        ) : null}
      </View>
    </Card>
  );
});
