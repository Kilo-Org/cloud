import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { I18nManager, Text as RNText, type Role } from 'react-native';

import { cn } from '@/lib/utils';

const textVariants = cva('text-foreground text-base font-medium', {
  variants: {
    variant: {
      default: '',
      h1: 'text-center text-4xl font-bold tracking-tight',
      h2: 'border-border border-b pb-2 text-3xl font-semibold tracking-tight',
      h3: 'text-2xl font-semibold tracking-tight',
      h4: 'text-xl font-semibold tracking-tight',
      p: 'mt-3 leading-7',
      blockquote: 'mt-4 border-l-2 pl-3 italic',
      code: 'bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono-semibold text-sm',
      lead: 'text-muted-foreground text-xl',
      large: 'text-lg font-semibold',
      small: 'text-sm font-medium leading-none',
      muted: 'text-muted-foreground text-sm',
      mono: 'font-mono-medium text-sm',
      eyebrow: 'font-mono-medium text-[10px] uppercase tracking-[1.5px] text-muted-foreground',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

type TextVariantProps = VariantProps<typeof textVariants>;

type TextVariant = NonNullable<TextVariantProps['variant']>;

const ROLE = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
} satisfies Partial<Record<TextVariant, Role>>;

const ARIA_LEVEL = {
  h1: '1',
  h2: '2',
  h3: '3',
  h4: '4',
} satisfies Partial<Record<TextVariant, string>>;

const TextClassContext = React.createContext<string | undefined>(undefined);

// RN 0.86 does not resolve `textAlign: 'auto'` from the native layout
// direction on iOS, so a full-width Text renders left-aligned in an RTL
// interface. Naming the paragraph's base direction makes the natural
// alignment resolve, and unlike `textAlign` it leaves `text-center` and
// friends alone. Applied only in RTL so LTR rendering is untouched, and it
// sits first so a caller's own `style` still wins (the language picker
// forces each row into its own script's direction that way).
const RTL_WRITING_DIRECTION = { writingDirection: 'rtl' } as const;

function Text({
  className,
  asChild = false,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof RNText> &
  TextVariantProps &
  React.RefAttributes<RNText> & {
    asChild?: boolean;
  }) {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot.Text : RNText;
  return (
    <Component
      className={cn(textVariants({ variant }), textClass, className)}
      role={variant ? ROLE[variant as keyof typeof ROLE] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant as keyof typeof ARIA_LEVEL] : undefined}
      {...props}
      style={I18nManager.isRTL ? [RTL_WRITING_DIRECTION, props.style] : props.style}
    />
  );
}

export { Text, TextClassContext };
