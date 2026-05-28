'use client';

import { cn } from '@/lib/utils';
import React from 'react';

export const SignInButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = 'button', disabled, ...props }, ref) => (
  <button
    className={cn(
      'bg-card text-foreground border-border',
      'flex h-10 w-full cursor-pointer items-center justify-center gap-2.5 rounded-md border px-4',
      'text-sm font-medium',
      'transition-colors duration-150',
      'hover:bg-accent hover:text-accent-foreground',
      'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
      '[&_svg]:size-4 [&_svg]:shrink-0',
      disabled && 'cursor-not-allowed opacity-50 hover:bg-card hover:text-foreground',
      className
    )}
    ref={ref}
    type={type}
    disabled={disabled}
    {...props}
  />
));
SignInButton.displayName = 'SignInButton';
