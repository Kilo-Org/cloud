import { type ReactNode } from 'react';

import { ScreenFooter } from '@/components/ui/screen-footer';

/**
 * Pinned primary action for the manual-review form.
 *
 * The action used to be the scroll body's last child. At large display
 * densities the form is taller than the viewport, so it was clipped mid-label
 * at the scroll fold, against the tab bar (explorer manual-review finding,
 * 2026-09-19). The footer reserves the screen's bottom clearance, so the call
 * to action is always fully legible.
 *
 * The host wraps this footer and the scroll body in the keyboard-lift view,
 * which owns the bottom space while the keyboard is open; the shared footer
 * handles its own lift against the IME, so the two never double-count.
 */
export function ManualReviewActionFooter({ children }: Readonly<{ children: ReactNode }>) {
  return <ScreenFooter clearance="tab-bar">{children}</ScreenFooter>;
}
