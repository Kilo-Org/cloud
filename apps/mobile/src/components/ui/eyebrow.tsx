import { type ComponentProps } from 'react';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type EyebrowProps = Omit<ComponentProps<typeof Text>, 'variant'>;

/**
 * Eyebrow label: mono, 10px. Defaults to muted color; pass a `className` with
 * a `text-*` token to override (e.g. agent hue).
 *
 * The uppercase, letterspaced display treatment is LTR-only: `letter-spacing`
 * breaks a cursive script's joins, so an RTL eyebrow renders the same copy
 * without it (see `Text`'s eyebrow variant).
 */
export function Eyebrow({ className, ...props }: EyebrowProps) {
  return <Text variant="eyebrow" className={cn(className)} {...props} />;
}
