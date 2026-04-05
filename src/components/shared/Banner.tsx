'use client';

import { createContext, useContext } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type BannerColor = 'emerald' | 'amber' | 'blue' | 'red' | 'green';
type BannerSize = 'default' | 'lg';

type ColorSet = {
  border: string;
  bg: string;
  text: string;
  button: string;
  outlineButton: string;
  iconBg: string;
  titleText: string;
  descText: string;
};

const colorMap: Record<BannerColor, { default: ColorSet; lg: ColorSet }> = {
  emerald: {
    default: {
      border: 'border-emerald-500/30',
      bg: 'bg-emerald-500/10',
      text: 'text-emerald-400',
      button: 'bg-emerald-500 text-primary-foreground hover:bg-emerald-500/90',
      outlineButton:
        'border border-emerald-500/40 bg-transparent text-emerald-400 hover:bg-emerald-500/10',
      iconBg: '',
      titleText: '',
      descText: 'text-muted-foreground',
    },
    lg: {
      border: 'border-emerald-900',
      bg: 'bg-emerald-950/30',
      text: 'text-emerald-400',
      button: 'bg-emerald-700 text-white hover:bg-emerald-700/90',
      outlineButton:
        'border border-emerald-700 bg-transparent text-emerald-400 hover:bg-emerald-950/50',
      iconBg: 'bg-emerald-900/50',
      titleText: 'text-emerald-100',
      descText: 'text-emerald-200',
    },
  },
  amber: {
    default: {
      border: 'border-amber-500/30',
      bg: 'bg-amber-500/10',
      text: 'text-amber-400',
      button: 'bg-amber-500 text-primary-foreground hover:bg-amber-500/90',
      outlineButton:
        'border border-amber-500/40 bg-transparent text-amber-400 hover:bg-amber-500/10',
      iconBg: '',
      titleText: '',
      descText: 'text-muted-foreground',
    },
    lg: {
      border: 'border-amber-900',
      bg: 'bg-amber-950/30',
      text: 'text-amber-400',
      button: 'bg-amber-700 text-white hover:bg-amber-700/90',
      outlineButton: 'border border-amber-700 bg-transparent text-amber-400 hover:bg-amber-950/50',
      iconBg: 'bg-amber-900/50',
      titleText: 'text-amber-100',
      descText: 'text-amber-200',
    },
  },
  blue: {
    default: {
      border: 'border-blue-500/30',
      bg: 'bg-blue-500/10',
      text: 'text-blue-400',
      button: 'bg-blue-500 text-primary-foreground hover:bg-blue-500/90',
      outlineButton: 'border border-blue-500/40 bg-transparent text-blue-400 hover:bg-blue-500/10',
      iconBg: '',
      titleText: '',
      descText: 'text-muted-foreground',
    },
    lg: {
      border: 'border-blue-900',
      bg: 'bg-blue-950/30',
      text: 'text-blue-400',
      button: 'bg-blue-700 text-white hover:bg-blue-700/90',
      outlineButton: 'border border-blue-700 bg-transparent text-blue-400 hover:bg-blue-950/50',
      iconBg: 'bg-blue-900/50',
      titleText: 'text-blue-100',
      descText: 'text-blue-200',
    },
  },
  red: {
    default: {
      border: 'border-red-500/30',
      bg: 'bg-red-500/10',
      text: 'text-red-400',
      button: 'bg-red-500 text-primary-foreground hover:bg-red-500/90',
      outlineButton: 'border border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10',
      iconBg: '',
      titleText: '',
      descText: 'text-muted-foreground',
    },
    lg: {
      border: 'border-red-900',
      bg: 'bg-red-950/30',
      text: 'text-red-400',
      button: 'bg-red-700 text-white hover:bg-red-700/90',
      outlineButton: 'border border-red-700 bg-transparent text-red-400 hover:bg-red-950/50',
      iconBg: 'bg-red-900/50',
      titleText: 'text-red-100',
      descText: 'text-red-200',
    },
  },
  green: {
    default: {
      border: 'border-green-500/30',
      bg: 'bg-green-500/10',
      text: 'text-green-400',
      button: 'bg-green-500 text-primary-foreground hover:bg-green-500/90',
      outlineButton:
        'border border-green-500/40 bg-transparent text-green-400 hover:bg-green-500/10',
      iconBg: '',
      titleText: '',
      descText: 'text-muted-foreground',
    },
    lg: {
      border: 'border-green-900',
      bg: 'bg-green-950/30',
      text: 'text-green-400',
      button: 'bg-green-700 text-white hover:bg-green-700/90',
      outlineButton: 'border border-green-700 bg-transparent text-green-400 hover:bg-green-950/50',
      iconBg: 'bg-green-900/50',
      titleText: 'text-green-100',
      descText: 'text-green-200',
    },
  },
};

type BannerContextValue = {
  colors?: ColorSet;
  size: BannerSize;
};

const BannerContext = createContext<BannerContextValue>({ size: 'default' });

function BannerRoot({
  color,
  size = 'default',
  className,
  role,
  children,
}: {
  color?: BannerColor;
  size?: BannerSize;
  className?: string;
  role?: string;
  children: React.ReactNode;
}) {
  const colors = color ? colorMap[color][size] : undefined;

  return (
    <BannerContext.Provider value={{ colors, size }}>
      <div
        role={role}
        className={cn(
          'relative flex w-full flex-wrap items-start gap-3 rounded-xl border',
          size === 'lg' ? 'gap-4 p-6' : 'p-4 sm:gap-4',
          size === 'default' && 'sm:items-center',
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
  const { colors, size } = useContext(BannerContext);

  if (size === 'lg') {
    return (
      <div className="shrink-0">
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-full',
            colors?.iconBg,
            className
          )}
        >
          {children}
        </div>
      </div>
    );
  }

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
  const { colors, size } = useContext(BannerContext);

  return (
    <p
      className={cn(
        'font-semibold',
        size === 'lg' ? 'text-xl' : 'text-sm sm:font-bold',
        colors?.titleText,
        className
      )}
    >
      {children}
    </p>
  );
}

function BannerDescription({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { colors, size } = useContext(BannerContext);

  return (
    <p
      className={cn(
        'text-sm',
        size === 'lg' ? 'mt-2' : 'mt-0.5 sm:mt-0',
        colors?.descText,
        className
      )}
    >
      {children}
    </p>
  );
}

function BannerAction({ children, className }: { children: React.ReactNode; className?: string }) {
  const { size } = useContext(BannerContext);

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-2 sm:flex-row',
        size === 'lg' ? 'mt-4 gap-3' : 'w-full sm:w-auto',
        className
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  href,
  target,
  onClick,
  children,
  className,
  variant = 'primary',
}: {
  href?: string;
  target?: string;
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
        <Link href={href} target={target}>
          {children}
        </Link>
      </Button>
    );
  }

  return (
    <Button className={btnClass} onClick={onClick}>
      {children}
    </Button>
  );
}

function BannerDismiss({ onDismiss, className }: { onDismiss: () => void; className?: string }) {
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
