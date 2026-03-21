'use client';

import type { ToasterProps } from 'sonner';
import { Toaster as Sonner } from 'sonner';

const DEFAULT_DURATION_MS = 4000;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      duration={DEFAULT_DURATION_MS * 2}
      closeButton
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--brand-primary)',
        } as React.CSSProperties
      }
      toastOptions={{
        className: 'toast-enlarged',
      }}
      {...props}
    />
  );
};

export { Toaster };
