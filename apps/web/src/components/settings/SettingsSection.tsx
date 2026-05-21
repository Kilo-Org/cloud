'use client';

/**
 * Settings section — the card wrapper used by gastown and wasteland
 * settings pages. Provides the consistent "icon + title + description +
 * optional action" header with a framed content well, plus a stagger
 * animation on mount. `id` is used by the scrollspy nav to anchor the
 * section in the DOM; `index` staggers the animation.
 */

import { motion } from 'motion/react';
import type { ComponentType, ReactNode } from 'react';

export type SettingsSectionIcon = ComponentType<{ className?: string }>;

export function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  index = 0,
  action,
  children,
}: {
  id?: string;
  title: string;
  description: string;
  icon: SettingsSectionIcon;
  index?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.section
      id={id}
      // scroll-margin-top gives a CSS-level offset for programmatic scroll
      // so the sticky header doesn't cover the section heading. Matches
      // the rootMargin used by the scrollspy observer (~56px header +
      // 24px breathing room).
      style={{ scrollMarginTop: 80 }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.35 }}
    >
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-white/[0.06]">
            <Icon className="size-4 text-white/40" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white/85">{title}</h2>
            <p className="mt-0.5 text-xs text-white/35">{description}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">{children}</div>
    </motion.section>
  );
}
