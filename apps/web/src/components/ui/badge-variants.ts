import { cva, type VariantProps } from 'class-variance-authority';

const badgeVariants = cva(
  'type-label inline-flex items-center justify-center rounded-md border px-2 py-0.5 w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        'secondary-outline': 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'border-transparent bg-destructive/60 text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/40',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        beta: 'rounded-full bg-blue-500/10 px-3 py-1 font-semibold text-blue-400 ring-1 ring-blue-500/20 border-transparent',
        new: 'rounded-full bg-green-500/10 px-3 py-1 font-semibold text-green-400 ring-1 ring-green-500/20 border-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type BadgeVariantProps = VariantProps<typeof badgeVariants>;

export { badgeVariants, type BadgeVariantProps };
