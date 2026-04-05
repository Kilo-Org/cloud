'use client';

/**
 * Client-only card UI components
 */

import * as React from 'react';
import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface CardLinkFooterProps extends React.ComponentProps<typeof Link> {
  className?: string;
  children: React.ReactNode;
}

/**
 * CardLinkFooter component with liquid ripple effect on hover.
 * Use this component for card footers that are also primary CTA's
 */
export const CardLinkFooter = React.forwardRef<HTMLAnchorElement, CardLinkFooterProps>(
  ({ className, children, ...props }, ref) => {
    const [isAnimating, setIsAnimating] = useState(false);
    const [rippleOrigin, setRippleOrigin] = useState({ x: 50, y: 50 });

    const handleMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isAnimating) {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;

        setRippleOrigin({ x, y });
        setIsAnimating(true);
        setTimeout(() => setIsAnimating(false), 600);
      }
    };

    return (
      <>
        <Link
          ref={ref}
          onMouseEnter={handleMouseEnter}
          className={cn(
            'text-muted-foreground relative mt-6 -mr-6 -mb-6 -ml-6 overflow-hidden rounded-br-2xl rounded-bl-2xl border-t border-t-[#2c2c2c] px-4 py-3 text-sm transition-colors hover:bg-gray-900',
            isAnimating ? 'animate-liquid-ripple' : '',
            className
          )}
          {...props}
        >
          {isAnimating && (
            <div
              className="pointer-events-none absolute inset-0 rounded-br-2xl rounded-bl-2xl"
              style={{
                background: `radial-gradient(circle at ${rippleOrigin.x}% ${rippleOrigin.y}%, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 50%, transparent 70%)`,
                animation: 'liquidRipple 0.6s ease-out forwards',
              }}
            />
          )}
          {children}
        </Link>
        <style jsx>{
          /* css */ `
            @keyframes liquidRipple {
              0% {
                transform: scale(0);
                opacity: 1;
              }
              50% {
                transform: scale(1.2);
                opacity: 0.8;
              }
              100% {
                transform: scale(2);
                opacity: 0;
              }
            }

            .animate-liquid-ripple {
              position: relative;
            }
          `
        }</style>
      </>
    );
  }
);
CardLinkFooter.displayName = 'CardLinkFooter';
