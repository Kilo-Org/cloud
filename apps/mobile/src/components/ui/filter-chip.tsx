import { View } from 'react-native';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * One option of a single-select chip row.
 *
 * Every chip paints its edge as an absolutely positioned overlay, so neither
 * state's size, padding or hit area changes when the selection moves. An
 * unselected chip draws the palette's `border` token, which is what makes it
 * read as a chip on the page rather than as loose text; the selected one keeps
 * the row's neutral `secondary` surface and paints the stronger 1 dp
 * `muted-foreground` ring over the same edge. Its label stays in the default
 * `foreground` ink. The fill alone separates from the page by only 1.1:1 light
 * and 1.2:1 dark, while the ring clears 5.1:1 light and 5.3:1 dark against the
 * page and 4.6:1 / 4.5:1 against the selected fill. Both are muted neutrals, so
 * the brand `primary` ink and fill stay with the page's primary action instead
 * of repeating on every chip row.
 *
 * `size` stays pinned to `sm` (its 36pt frame plus `COMPACT_BUTTON_HIT_SLOP`)
 * and the caller owns the entry's role; the caller's `accessibilityState` is
 * kept, with `selected` set from this component so the announced state always
 * matches the painted one.
 */
export function FilterChip({
  selected,
  label,
  className,
  accessibilityState,
  ...props
}: Readonly<
  Omit<ButtonProps, 'variant' | 'size' | 'children'> & { selected: boolean; label: string }
>) {
  return (
    <Button
      {...props}
      variant={selected ? 'secondary' : 'ghost'}
      size="sm"
      className={className}
      accessibilityState={{ ...accessibilityState, selected }}
    >
      <View
        pointerEvents="none"
        className={cn(
          'absolute inset-0 rounded-md border',
          selected ? 'border-muted-foreground' : 'border-border'
        )}
      />
      <Text>{label}</Text>
    </Button>
  );
}
