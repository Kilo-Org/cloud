import { View } from 'react-native';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

type SessionListSectionHeaderProps = {
  title: string;
  count: number;
  /**
   * True for the in-flow copy of the date header FlashList is currently
   * pinning. FlashList renders a pinned header a second time in an absolutely
   * positioned sticky overlay, so both copies land in the accessibility tree
   * and TalkBack/`VoiceOver` reads the pinned date twice. The overlay copy
   * stays announced, so the in-flow copy removes itself from the tree and
   * exactly one node per pinned header remains.
   */
  hiddenFromA11y?: boolean;
};

/**
 * Shared "section header + mono count" row used by the Agents list
 * date sections AND the pinned "Active now" tray. Matches the existing
 * `flex-row items-center justify-between bg-background px-[22px] pb-2
 * pt-[18px]` header with `<Eyebrow>` + a mono count
 * `text-[10px] uppercase tracking-[1.5px] text-muted-foreground`.
 */
export function SessionListSectionHeader({
  title,
  count,
  hiddenFromA11y = false,
}: Readonly<SessionListSectionHeaderProps>) {
  return (
    <View
      accessibilityElementsHidden={hiddenFromA11y}
      importantForAccessibility={hiddenFromA11y ? 'no-hide-descendants' : 'auto'}
      className="flex-row items-center justify-between bg-background px-[22px] pb-2 pt-[18px]"
    >
      <Eyebrow>{title}</Eyebrow>
      <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        {formatNumber(count, i18n.language)}
      </Text>
    </View>
  );
}
