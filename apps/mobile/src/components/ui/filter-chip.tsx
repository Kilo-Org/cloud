import { View } from 'react-native';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * One option of a single-select chip row.
 *
 * The active option keeps the row's neutral `secondary` surface and adds a
 * 1 dp `muted-foreground` ring over the chip's edge; its label stays in the
 * default `foreground` ink. The fill alone separates from the page by only
 * 1.1:1 light and 1.2:1 dark, while the ring clears 5.1:1 light and 5.3:1
 * dark against the page and 4.6:1 / 4.5:1 against the selected fill. The ring
 * is a muted neutral, so the brand `primary` ink and fill stay with the page's
 * primary action instead of repeating on every chip row.
 *
 * The ring is painted as an absolutely positioned overlay, so neither state's
 * size, padding or hit area changes when the selection moves; the unselected
 * chips stay unpainted. `size` stays pinned to `sm` (36pt plus the button's
 * 4pt hitSlop) and the caller owns the entry's role; the caller's
 * `accessibilityState` is kept, with `selected` set from this component so the
 * announced state always matches the painted one.
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
      {selected ? (
        <View
          pointerEvents="none"
          className="border-muted-foreground absolute inset-0 rounded-md border"
        />
      ) : null}
      <Text>{label}</Text>
    </Button>
  );
}
