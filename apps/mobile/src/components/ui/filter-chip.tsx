import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * One option of a single-select chip row. The selected chip takes the app's
 * primary fill, which clears 7.2:1 against the light page and 14.3:1 against
 * the dark one and changes the label to the matching foreground. The variants
 * it replaces — `secondary` for the active chip, `ghost` for the rest — painted
 * a 1.1:1 fill and left the label at the same colour, so the current filter was
 * visible only to a screen reader. Unselected chips stay transparent, so the
 * row keeps its geometry.
 *
 * `size` stays pinned to `sm` (36pt plus the button's 4pt hitSlop) and the
 * caller owns the accessibility entry, so a chip row keeps announcing the same
 * selected state it did before.
 */
export function FilterChip({
  selected,
  ...props
}: Readonly<Omit<ButtonProps, 'variant' | 'size'> & { selected: boolean }>) {
  return <Button {...props} variant={selected ? 'default' : 'ghost'} size="sm" />;
}
