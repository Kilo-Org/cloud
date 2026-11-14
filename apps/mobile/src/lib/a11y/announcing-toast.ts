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

// `announceForA11y` trims, drops empty messages, and swallows a native
// accessibility failure, so the visual toast always renders.
//
// The `options` argument is forwarded only when the caller passed one: a
// `toast.error(title, undefined)` call is not the same assertion as
// `toast.error(title)`, and the suites that assert a bare copy keep matching
// only while the adapter adds no second argument of its own.

function success(title: string, options?: ToastOptions): string | number {
  announceForA11y(title);
  return options === undefined ? toast.success(title) : toast.success(title, options);
}

function error(title: string, options?: ToastOptions): string | number {
  announceForA11y(title);
  return options === undefined ? toast.error(title) : toast.error(title, options);
}

function warning(title: string, options?: ToastOptions): string | number {
  announceForA11y(title);
  return options === undefined ? toast.warning(title) : toast.warning(title, options);
}

export const announcingToast = { success, error, warning };
