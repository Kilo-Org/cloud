'use client';

import type { ReactNode } from 'react';
import { useTerminalBar, COLLAPSED_SIZE, isHorizontal } from './TerminalBarContext';

/**
 * Client component that wraps page content and applies dynamic padding
 * to clear the fixed terminal bar. Replaces the static `pb-[340px]`
 * in layouts with position/size/collapse-aware padding.
 */
export function TerminalBarPadding({ children }: { children: ReactNode }) {
  const { position, size, collapsed } = useTerminalBar();

  const totalSize = collapsed ? COLLAPSED_SIZE : COLLAPSED_SIZE + size;

  const style: React.CSSProperties = {};

  if (isHorizontal(position)) {
    if (position === 'bottom') {
      style.paddingBottom = `${totalSize}px`;
    } else {
      style.paddingTop = `${totalSize}px`;
    }
  } else {
    if (position === 'right') {
      style.paddingRight = `${totalSize}px`;
    } else {
      style.paddingLeft = `${totalSize}px`;
    }
  }

  return (
    <div className="flex min-h-screen flex-col" style={style}>
      <div className="flex-1">{children}</div>
    </div>
  );
}
