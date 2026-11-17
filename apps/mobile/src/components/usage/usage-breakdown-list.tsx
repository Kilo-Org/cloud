import { useTranslation } from 'react-i18next';

import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { formatPercent } from '@/lib/format';

import { formatUsageCost, humanizeDimension } from './usage-format';

type UsageBreakdownEntry = {
  key: string;
  label: string;
  value: number;
  percentage: number;
};

type UsageBreakdownListProps = {
  title: string;
  entries: readonly UsageBreakdownEntry[];
  /**
   * Feature and mode keys are slugs that read as words; model keys are ids
   * (`anthropic/claude-sonnet-4`), and web renders those verbatim.
   */
  humanize?: boolean;
};

/**
 * The cost leaders for one dimension. Each row names the model or feature, its
 * cost and its share of the returned rows — the same three facts web's
 * breakdown columns carry.
 */
export function UsageBreakdownList({
  title,
  entries,
  humanize = false,
}: Readonly<UsageBreakdownListProps>) {
  const { i18n } = useTranslation();
  if (entries.length === 0) {
    return null;
  }

  return (
    <Section label={title}>
      <RowGroup>
        {entries.map(entry => (
          <KvRow
            key={entry.key}
            label={humanize ? humanizeDimension(entry.label, i18n.language) : entry.label}
            // A model id can be long; the cost and the share are the columns a
            // reader compares, so the name yields its width to them.
            labelShrink
            value={formatUsageCost(entry.value, i18n.language)}
            valueFace="numeric"
            trailing={
              <Text variant="caption" className="w-12 shrink-0 text-right tabular-nums">
                {formatPercent(entry.percentage, i18n.language)}
              </Text>
            }
          />
        ))}
      </RowGroup>
    </Section>
  );
}
