import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type GastownBackdropProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

export function GastownBackdrop({ children, className, contentClassName }: GastownBackdropProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-black/25 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)]',
        className
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-90 [background:radial-gradient(circle_at_18%_0%,rgba(237,255,0,0.14),transparent_48%),radial-gradient(circle_at_84%_22%,rgba(56,189,248,0.12),transparent_44%),radial-gradient(circle_at_60%_120%,rgba(34,197,94,0.10),transparent_46%),linear-gradient(to_bottom,rgba(255,255,255,0.06),transparent_35%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay [background:repeating-linear-gradient(90deg,rgba(255,255,255,0.06)_0px,rgba(255,255,255,0.06)_1px,transparent_1px,transparent_10px)]"
      />
      <div className={cn('relative', contentClassName)}>{children}</div>
    </div>
  );
}
