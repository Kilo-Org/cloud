import { type ComponentProps } from 'react';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type EyebrowProps = Omit<ComponentProps<typeof Text>, 'variant'>;

/**
 * Eyebrow label: mono, 10px. Defaults to muted color; pass a `className` with
 * a `text-*` token to override (e.g. agent hue).
 *
 * The uppercase, letterspaced display treatment is the Latin one: `Text`
 * keeps its class in both directions and resets the letter-spacing in RTL, so
 * an Arabic eyebrow renders the same copy unspaced (see `Text`'s eyebrow
 * variant and `@/lib/rtl-text`).
 */
export function Eyebrow({ className, ...props }: EyebrowProps) {
  return <Text variant="eyebrow" className={cn(className)} {...props} />;
}
