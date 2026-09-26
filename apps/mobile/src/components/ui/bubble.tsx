import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text, TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type BubbleProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Chat bubble with asymmetric radius: accent-soft (lime) tile, tail at top-right,
 * ink-on-lime text.
 */
export function Bubble({ children, className }: Readonly<BubbleProps>) {
  return (
    <View
      className={cn(
        'self-end max-w-[82%] rounded-2xl rounded-tr-sm bg-accent-soft px-3.5 py-2.5',
        className
      )}
    >
      <TextClassContext.Provider value="text-accent-soft-foreground font-medium text-[15px] leading-[21px]">
        {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string variant
          typeof children === 'string' ? <Text>{children}</Text> : children
        }
      </TextClassContext.Provider>
    </View>
  );
}
