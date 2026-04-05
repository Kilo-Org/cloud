'use client';

import { cn } from '@/lib/utils';
import React from 'react';

export const SignInButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = 'button', disabled, ...props }, ref) => (
  <button
    className={cn(
      'bg-background mx-auto mb-4 flex h-12 w-full max-w-sm cursor-pointer items-center justify-center gap-2 rounded-md border px-4 text-lg font-medium transition-colors hover:bg-gray-800',
      disabled && 'hover:bg-background cursor-not-allowed opacity-50',
      className
    )}
    ref={ref}
    type={type}
    disabled={disabled}
    {...props}
  />
));
