import { type ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * The control chrome of a bordered input surface: the contract's control
 * radius, the input border token, and the fill the input recipe gives the field
 * (the canvas in light, 4 % white over it in dark — `bg-background` alone left
 * the field with no surface of its own, see `FormField`).
 *
 * A single-line `Input` carries the same chrome on its own box. A multiline
 * field or a composer keeps its own text metrics and insets, so its surface is
 * this wrapper instead: the field fills it, and the frame draws the border.
 */
export const INPUT_FRAME_CLASS = 'rounded-md border border-input bg-background dark:bg-[#FFFFFF0A]';

type InputFrameProps = ViewProps & {
  /**
   * Non-surface layout only: flex sizing, a minimum height, clipping for a
   * child that paints past the radius, a disabled-opacity state.
   */
  className?: string;
  children: ReactNode;
};

/**
 * The bordered surface of an input: the composer and every multiline field sit
 * in it instead of spelling `border-input` chrome beside a bare field. The
 * field inside keeps its own insets, placeholder and measurement handlers, and
 * the caller's layout classes (including `onLayout`) ride on the frame.
 */
export function InputFrame({ className, children, ...props }: Readonly<InputFrameProps>) {
  return (
    <View {...props} className={cn(INPUT_FRAME_CLASS, className)}>
      {children}
    </View>
  );
}
