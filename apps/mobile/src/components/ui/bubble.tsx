import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text, TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type BubbleProps = {
  side: 'assistant' | 'user';
  children: ReactNode;
  className?: string;
};

/**
 * Chat bubble with asymmetric radius.
 * Assistant: card surface with hairline border, tail at top-left.
 * User: accent-soft (lime) tile, tail at top-right, ink-on-lime text.
 */
export function Bubble({ side, children, className }: Readonly<BubbleProps>) {
  if (side === 'user') {
    return (
      <View
        className={cn(
          'self-end max-w-[82%] rounded-2xl rounded-tr-sm bg-accent-soft px-3.5 py-2.5',
          className
        )}
      >
        <TextClassContext.Provider value="text-accent-soft-foreground font-medium text-[15px] leading-[21px]">
          {typeof children === 'string' ? <Text>{children}</Text> : children}
        </TextClassContext.Provider>
      </View>
    );
  }
  return (
    <View
      className={cn(
        'self-start max-w-[82%] rounded-2xl rounded-tl-sm border border-border bg-card px-3.5 py-2.5',
        className
      )}
    >
      <TextClassContext.Provider value="text-foreground font-medium text-[15px] leading-[21px]">
        {typeof children === 'string' ? <Text>{children}</Text> : children}
      </TextClassContext.Provider>
    </View>
  );
}
