'use client';

/**
 * Client-only card UI components
 */

import * as React from 'react';
import Link, { type LinkProps } from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export type CardLinkFooterProps = LinkProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    className?: string;
    children: React.ReactNode;
  };

/**
 * CardLinkFooter component with liquid ripple effect on hover.
 * Use this component for card footers that are also primary CTA's
 */
export const CardLinkFooter = React.forwardRef<HTMLAnchorElement, CardLinkFooterProps>(
  ({ className, children, onMouseEnter, onMouseLeave, onMouseMove, ...props }, ref) => {
    const [isHovering, setIsHovering] = useState(false);
    const [rippleOrigin, setRippleOrigin] = useState({ x: 50, y: 50 });

    const updateRippleOrigin = (event: React.MouseEvent<HTMLAnchorElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
      const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
      setRippleOrigin({ x, y });
    };

    const handleMouseEnter = (event: React.MouseEvent<HTMLAnchorElement>) => {
      onMouseEnter?.(event);
      updateRippleOrigin(event);
      setIsHovering(true);
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLAnchorElement>) => {
      onMouseMove?.(event);
      updateRippleOrigin(event);
    };

    const handleMouseLeave = (event: React.MouseEvent<HTMLAnchorElement>) => {
      onMouseLeave?.(event);
      setIsHovering(false);
    };

    return (
      <Link
        ref={ref}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className={cn(
          'text-muted-foreground relative mt-6 -mr-6 -mb-6 -ml-6 overflow-hidden rounded-br-2xl rounded-bl-2xl border-t border-t-[#2c2c2c] px-4 py-3 text-sm transition-colors hover:bg-gray-900',
          className
        )}
        {...props}
      >
        <div
          aria-hidden="true"
          className={cn(
            'card-link-footer-ripple pointer-events-none absolute inset-0 rounded-br-2xl rounded-bl-2xl',
            isHovering && 'card-link-footer-ripple-active'
          )}
          style={{
            background: `radial-gradient(circle at ${rippleOrigin.x}% ${rippleOrigin.y}%, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 50%, transparent 70%)`,
            visibility: isHovering ? 'visible' : 'hidden',
          }}
        />
        {children}
      </Link>
    );
  }
);
CardLinkFooter.displayName = 'CardLinkFooter';
