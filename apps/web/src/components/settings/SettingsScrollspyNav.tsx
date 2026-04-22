'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { SettingsSectionIcon } from './SettingsSection';

export type SettingsNavItem = {
  id: string;
  label: string;
  icon: SettingsSectionIcon;
};

/**
 * Right-side scrollspy navigation. Hidden below the `lg` breakpoint.
 * Sticks to the nearest scrolling ancestor — when the sticky header is
 * inside the same scroll viewport (gastown, viewport-scroll), pass
 * `stickyTopPx={53}` (or whatever the header measures) so the nav sits
 * below it. When the sticky header is outside the scroll viewport
 * (wasteland, nested scroll), leave `stickyTopPx` at 0.
 * `layoutId` ensures the active-indicator dot animates between items
 * rather than fading.
 *
 * `footer` is a pass-through slot for a mirrored save button or any
 * other per-page action.
 */
export function SettingsScrollspyNav({
  items,
  activeId,
  onNavigate,
  layoutId = 'settings-nav-indicator',
  stickyTopPx = 0,
  footer,
}: {
  items: readonly SettingsNavItem[];
  activeId: string;
  onNavigate: (id: string) => void;
  layoutId?: string;
  stickyTopPx?: number;
  footer?: ReactNode;
}) {
  return (
    <div
      className="hidden w-52 shrink-0 lg:sticky lg:block lg:self-start"
      style={{ top: stickyTopPx }}
    >
      <nav className="px-4 pt-6">
        <div className="mb-3 text-[10px] font-medium tracking-wide text-white/25 uppercase">
          On this page
        </div>
        <ul className="space-y-0.5">
          {items.map(item => {
            const isActive = activeId === item.id;
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <button
                  onClick={() => onNavigate(item.id)}
                  className={`flex w-full items-center gap-2 overflow-hidden rounded-md px-2.5 py-1.5 text-left text-xs whitespace-nowrap text-ellipsis transition-colors ${
                    isActive
                      ? 'bg-white/[0.06] text-white/80'
                      : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
                  }`}
                >
                  <Icon className="size-3 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {isActive && (
                    <motion.div
                      layoutId={layoutId}
                      className="ml-auto size-1 rounded-full bg-[color:oklch(95%_0.15_108)]"
                      transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {footer && <div className="mt-6 border-t border-white/[0.06] pt-4">{footer}</div>}
      </nav>
    </div>
  );
}
