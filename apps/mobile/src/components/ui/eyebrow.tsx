import { type ComponentProps } from 'react';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type EyebrowProps = Omit<ComponentProps<typeof Text>, 'variant'>;

/**
 * Eyebrow label: mono and 10px in both directions. The letterspaced capitals
 * are the LTR treatment: `Text`'s eyebrow variant drops the mono family and
 * the tracking for Arabic copy in an RTL interface, where the script is
 * caseless and its letters join.
 * Defaults to muted color; pass a `className` with a `text-*` token to
 * override (e.g. agent hue).
 */
export function Eyebrow({ className, ...props }: EyebrowProps) {
  return <Text variant="eyebrow" className={cn(className)} {...props} />;
}
