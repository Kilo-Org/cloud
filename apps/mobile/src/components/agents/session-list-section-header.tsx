import { View } from 'react-native';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

type SessionListSectionHeaderProps = {
  title: string;
  count: number;
  /**
   * The whole row as one spoken heading. The row shows the title and a bare
   * numeral, which a screen reader would otherwise read as two unrelated
   * fragments; the caller names the count in the active language instead.
   */
  accessibilityLabel: string;
};

/**
 * Shared "section header + mono count" row used by the Agents list
 * date sections and the "Active now" tray. Matches the existing
 * `flex-row items-center justify-between bg-background px-[22px] pb-2
 * pt-[18px]` header with `<Eyebrow>` + a mono count
 * `text-[10px] uppercase tracking-[1.5px] text-muted-foreground`.
 *
 * The row is one accessible element with a header role, so the count belongs to
 * the heading it counts.
 */
export function SessionListSectionHeader({
  title,
  count,
  accessibilityLabel,
}: Readonly<SessionListSectionHeaderProps>) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={accessibilityLabel}
      className="flex-row items-center justify-between bg-background px-[22px] pb-2 pt-[18px]"
    >
      <Eyebrow>{title}</Eyebrow>
      <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        {formatNumber(count, i18n.language)}
      </Text>
    </View>
  );
}
