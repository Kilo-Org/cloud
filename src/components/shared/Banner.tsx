'use client';

import { createContext, useContext } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type BannerColor = 'emerald' | 'amber' | 'blue' | 'red';

const colorMap: Record<BannerColor, { border: string; bg: string; text: string; button: string }> =
  {
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
          'flex w-full flex-wrap items-start gap-3 rounded-xl border p-4 sm:items-center sm:gap-4',
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
  return <div className={cn('w-full shrink-0 sm:w-auto', className)}>{children}</div>;
}

function BannerButton({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { colors } = useContext(BannerContext);
  return (
    <Button
      asChild
      className={cn('w-full shrink-0 sm:w-auto [&>*]:h-4 [&>*]:w-4', colors?.button, className)}
    >
      <Link href={href}>{children}</Link>
    </Button>
  );
}

export const Banner = Object.assign(BannerRoot, {
  Icon: BannerIcon,
  Content: BannerContent,
  Title: BannerTitle,
  Description: BannerDescription,
  Action: BannerAction,
  Button: BannerButton,
});
