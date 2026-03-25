import Link from 'next/link';
import { cn } from '@/lib/utils';

type BannerColor = 'emerald' | 'amber' | 'blue' | 'red';

const colorMap: Record<
  BannerColor,
  { border: string; bg: string; text: string; button: string }
> = {
  emerald: {
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    button: 'bg-emerald-500 text-primary-foreground hover:bg-emerald-500/90',
  },
  amber: {
    border: 'border-amber-500/30',
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    button: 'bg-amber-500 text-primary-foreground hover:bg-amber-500/90',
  },
  blue: {
    border: 'border-blue-500/30',
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    button: 'bg-blue-500 text-primary-foreground hover:bg-blue-500/90',
  },
  red: {
    border: 'border-red-500/30',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    button: 'bg-red-500 text-primary-foreground hover:bg-red-500/90',
  },
};

type BannerProps = {
  /** Component type (auto-sized) or ReactNode (full control). */
  icon: React.ComponentType<{ className?: string }> | React.ReactNode;
  /** Override default icon classes (only when icon is a component type). */
  iconClassName?: string;
  title: string;
  description: React.ReactNode;
  /** Custom action element, overrides buttonLabel/buttonHref. */
  action?: React.ReactNode;
  buttonLabel?: string;
  buttonHref?: string;
  color: BannerColor;
};

export function Banner({
  icon,
  iconClassName,
  title,
  description,
  action,
  buttonLabel,
  buttonHref,
  color,
}: BannerProps) {
  const colors = colorMap[color];
  const IconComponent = typeof icon === 'function' ? icon : null;
  const iconNode = IconComponent
    ? <IconComponent className={cn('h-5 w-5 sm:h-6 sm:w-6', iconClassName)} />
    : icon;

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:gap-4',
        colors.border,
        colors.bg,
        colors.text
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center sm:gap-4">
        <div className="mt-0.5 flex shrink-0 items-center sm:mt-0">
          {iconNode}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold sm:font-bold">{title}</p>
          <p className="text-muted-foreground mt-0.5 text-sm sm:mt-0">{description}</p>
        </div>
      </div>
      {action ??
        (buttonLabel && buttonHref && (
          <Link
            href={buttonHref}
            className={cn(
              'inline-flex w-full shrink-0 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors sm:w-auto',
              colors.button
            )}
          >
            {buttonLabel}
          </Link>
        ))}
    </div>
  );
}
