import { type ComponentProps } from 'react';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type EyebrowProps = Omit<ComponentProps<typeof Text>, 'variant'>;

/**
 * Eyebrow label: mono, 10px. Defaults to muted color; pass a `className` with
 * a `text-*` token to override (e.g. agent hue).
 */
export function Eyebrow({ className, ...props }: EyebrowProps) {
  return <Text variant="eyebrow" className={cn(className)} {...props} />;
}
