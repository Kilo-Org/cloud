import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'type-label inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3 aria-invalid:border-destructive aria-invalid:ring-destructive/40',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'border-border bg-secondary text-secondary-foreground [a&]:hover:bg-accent',
        'secondary-outline': 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'border-status-destructive-border bg-status-destructive-surface text-status-destructive [a&]:hover:bg-destructive/20 focus-visible:ring-destructive/40',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        beta: 'border-status-neutral-border bg-status-neutral-surface text-status-neutral',
        new: 'border-status-success-border bg-status-success-surface text-status-success',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type BadgeVariantProps = VariantProps<typeof badgeVariants>;

export { badgeVariants, type BadgeVariantProps };
