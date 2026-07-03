import { cva, type VariantProps } from 'class-variance-authority';
import { Pressable } from 'react-native';

import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'group shrink-0 flex-row items-center justify-center gap-2 rounded-md shadow-none',
  {
    variants: {
      variant: {
        default: 'bg-primary active:opacity-80 shadow-sm shadow-black/5',
        destructive: 'bg-destructive active:opacity-80 shadow-sm shadow-black/5',
        outline: 'border-border bg-card active:opacity-80 border shadow-sm shadow-black/5',
        secondary: 'bg-secondary active:opacity-80 shadow-sm shadow-black/5',
        ghost: 'active:opacity-60',
        link: '',
        'accent-soft': 'bg-accent-soft active:opacity-80 shadow-sm shadow-black/5',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 gap-1.5 rounded-md px-3',
        lg: 'h-11 rounded-md px-6',
        icon: 'h-10 w-10',
        touch: 'h-11 min-w-11 px-4 py-2',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const buttonTextVariants = cva('text-foreground text-sm font-semibold', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
      link: 'text-primary group-active:underline',
      'accent-soft': 'text-accent-soft-foreground',
    },
    size: {
      default: '',
      sm: '',
      lg: '',
      icon: '',
      touch: '',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(props.disabled && 'opacity-50', buttonVariants({ variant, size }), className)}
        role="button"
        {...props}
      />
    </TextClassContext.Provider>
  );
}

type IconButtonProps = Omit<ButtonProps, 'accessibilityLabel' | 'children' | 'role'> & {
  /** Required — icon-only buttons must announce their action. */
  accessibilityLabel: string;
  children: React.ReactNode;
};

/**
 * Icon-only `Button`. Requires `accessibilityLabel` at the type level so
 * VoiceOver / TalkBack always has a name. Use for dense toolbars; consider
 * adding `hitSlop` to reach a 44dp effective target where the visual is
 * smaller than 44dp.
 */
function IconButton({ className, variant = 'outline', size = 'icon', ...props }: IconButtonProps) {
  return <Button variant={variant} size={size} className={className} role="button" {...props} />;
}

export { Button, buttonTextVariants, buttonVariants, IconButton };
export type { ButtonProps, IconButtonProps };
