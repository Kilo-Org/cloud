'use client';

import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SettingsSectionIcon } from './SettingsSection';

/**
 * Sticky top bar shown above settings content. Sticks to the nearest
 * scrolling ancestor — when the page uses a nested scroll container,
 * the id here is used by the scrollspy hook to offset click targets.
 */
export function SettingsStickyHeader({
  id = 'settings-sticky-header',
  title = 'Settings',
  subtitle,
  icon: Icon = Settings,
  leading,
  actions,
}: {
  id?: string;
  title?: string;
  subtitle?: string;
  icon?: SettingsSectionIcon;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      id={id}
      className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3"
    >
      <div className="flex items-center gap-2.5">
        {leading}
        <Icon className="size-4 text-white/40" />
        <h1 className="text-lg font-semibold tracking-tight text-white/90">{title}</h1>
        {subtitle && <span className="text-sm text-white/30">{subtitle}</span>}
      </div>
      {actions}
    </div>
  );
}
