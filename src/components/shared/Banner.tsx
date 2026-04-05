'use client';

import { createContext, useContext } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type BannerColor = 'emerald' | 'amber' | 'blue' | 'red' | 'green';

const colorMap: Record<
  BannerColor,
  { border: string; bg: string; text: string; button: string; outlineButton: string }
> = {
  emerald: {
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    button: 'bg-emerald-500 text-primary-foreground hover:bg-emerald-500/90',
    outlineButton: 'border border-emerald-500/40 bg-transparent text-emerald-400 hover:bg-emerald-500/10',
  },
  amber: {
    border: 'border-amber-500/30',
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    button: 'bg-amber-500 text-primary-foreground hover:bg-amber-500/90',
    outlineButton: 'border border-amber-500/40 bg-transparent text-amber-400 hover:bg-amber-500/10',
  },
  blue: {
    border: 'border-blue-500/30',
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    button: 'bg-blue-500 text-primary-foreground hover:bg-blue-500/90',
    outlineButton: 'border border-blue-500/40 bg-transparent text-blue-400 hover:bg-blue-500/10',
  },
  red: {
    border: 'border-red-500/30',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    button: 'bg-red-500 text-primary-foreground hover:bg-red-500/90',
    outlineButton: 'border border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10',
  },
  green: {
    border: 'border-green-500/30',
    bg: 'bg-green-500/10',
    text: 'text-green-400',
    button: 'bg-green-500 text-primary-foreground hover:bg-green-500/90',
    outlineButton: 'border border-green-500/40 bg-transparent text-green-400 hover:bg-green-500/10',
  },
};

const BannerContext = createContext<{ colors?: (typeof colorMap)[BannerColor] }>({});

function BannerRoot({
  color,
  className,
  role,
  children,
}: {
  color?: BannerColor;
  className?: string;
  role?: string;
  children: React.ReactNode;
}) {
  const colors = color ? colorMap[color] : undefined;

  return (
    <BannerContext.Provider value={{ colors }}>
      <div
        role={role}
        className={cn(
          'relative flex w-full flex-wrap items-start gap-3 rounded-xl border p-4 sm:items-center sm:gap-4',
          colors?.border,
          colors?.bg,
          colors?.text,
          className
        )}
      >
        {children}
      </div>
    </BannerContext.Provider>
  );
}

function BannerIcon({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mt-0.5 flex shrink-0 items-center sm:mt-0 [&>*]:h-5 [&>*]:w-5 sm:[&>*]:h-6 sm:[&>*]:w-6',
        className
      )}
    >
      {children}
    </div>
  );
}

function BannerContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('min-w-0 flex-1', className)}>{children}</div>;
}

function BannerTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-sm font-semibold sm:font-bold', className)}>{children}</p>;
}

function BannerDescription({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('text-muted-foreground mt-0.5 text-sm sm:mt-0', className)}>{children}</p>
  );
}

function BannerAction({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row', className)}>{children}</div>;
}

function BannerButton({
  href,
  onClick,
  children,
  className,
  variant = 'primary',
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
  variant?: 'primary' | 'outline' | 'secondary' | 'ghost';
}) {
  const { colors } = useContext(BannerContext);

  const variantClasses = {
    primary: colors?.button,
    outline: colors?.outlineButton,
    secondary: 'bg-white/10 text-white hover:bg-white/15',
    ghost: 'bg-transparent text-white/70 hover:text-white hover:bg-white/5',
  };

  const btnClass = cn(
    'w-full shrink-0 sm:w-auto [&>*]:h-4 [&>*]:w-4',
    variantClasses[variant],
    className
  );

  if (href) {
    return (
      <Button asChild className={btnClass}>
        <Link href={href}>{children}</Link>
      </Button>
    );
  }

  return (
    <Button className={btnClass} onClick={onClick}>
      {children}
    </Button>
  );
}

function BannerDismiss({
  onDismiss,
  className,
}: {
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onDismiss}
      className={cn(
        'absolute right-3 top-3 rounded-full p-1 opacity-70 transition-opacity hover:opacity-100',
        className
      )}
      aria-label="Dismiss"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

export const Banner = Object.assign(BannerRoot, {
  Icon: BannerIcon,
  Content: BannerContent,
  Title: BannerTitle,
  Description: BannerDescription,
  Action: BannerAction,
  Button: BannerButton,
  Dismiss: BannerDismiss,
});
