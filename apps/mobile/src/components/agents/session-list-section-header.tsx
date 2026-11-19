import { View } from 'react-native';

import { SectionHeader } from '@/components/ui/section-header';
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
 * Shared "section header + mono count" row used by the Agents list date
 * sections and the "Active now" tray. It is the contract's `SectionHeader` with
 * the count as its notice, so the label and the numeral share the eyebrow scale
 * the rest of the app uses, and the header draws the gutter of the full-bleed
 * rows it names.
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
    <View accessible accessibilityRole="header" accessibilityLabel={accessibilityLabel}>
      <SectionHeader
        label={title}
        inset
        notice={<Text variant="eyebrow">{formatNumber(count, i18n.language)}</Text>}
      />
    </View>
  );
}
