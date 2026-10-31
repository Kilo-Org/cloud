import { View } from 'react-native';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * One option of a single-select chip row.
 *
 * The active option keeps the row's neutral `secondary` surface and adds a
 * 1 dp `primary` ring drawn over the chip's edge, with the label in the same
 * `primary` ink. The fill alone separated from the page by only 1.1:1 light
 * and 1.2:1 dark, while the ring clears 7.2:1 light and 14.3:1 dark against
 * the page and the unselected chips, and the label clears 6.5:1 and 12.2:1
 * against the fill. A saturated `primary` block would instead compete with the
 * page's primary action, which is the only place the brand fill is spent.
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
          className="border-primary absolute inset-0 rounded-md border"
        />
      ) : null}
      <Text className={selected ? 'text-primary' : undefined}>{label}</Text>
    </Button>
  );
}