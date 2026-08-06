import { toast } from 'sonner-native';

import { announceForA11y } from './announce';

// Announcing toast adapter. Wraps `sonner-native`'s `toast.success`,
// `toast.error`, and `toast.warning` so consequential outcomes (mutation
// results, command terminal states, action results) are also surfaced to
// assistive technologies via `announceForA11y`. The visual toast is
// unchanged — the announcement runs in addition to the rendered notification,
// so sighted users see the same UI and screen-reader users hear the same
// outcome.
//
// Use this adapter for any toast that communicates a consequential outcome
// (success/error/warning) the user must hear about. Cosmetic / informational
// toasts (`toast.info`, `toast.loading`, `toast.promise`, `toast.custom`,
// `toast.dismiss`) should continue to import `toast` from `sonner-native`
// directly — announcing them would add noise without adding meaning.

type ToastOptions = NonNullable<Parameters<typeof toast.success>[1]>;

function announceTitle(title: string): void {
  // `announceForA11y` trims, drops empty messages, and swallows a native
  // accessibility failure, so the visual toast always renders.
  announceForA11y(title);
}

function success(title: string, options?: ToastOptions): string | number {
  announceTitle(title);
  return toast.success(title, options);
}

function error(title: string, options?: ToastOptions): string | number {
  announceTitle(title);
  return toast.error(title, options);
}

function warning(title: string, options?: ToastOptions): string | number {
  announceTitle(title);
  return toast.warning(title, options);
}

export const announcingToast = { success, error, warning };
