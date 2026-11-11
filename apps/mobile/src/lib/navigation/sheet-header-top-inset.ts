import { type SheetHeaderTopInset } from '@/lib/form-sheet';
import { useRouteIsStackRoot } from '@/lib/navigation/route-focus';

/**
 * The surface mode a header uses inside a `formSheet` route: a sheet that is
 * its stack's first screen presents at the window top, so its header reserves
 * the inset; a sheet pushed over another screen settles an inset lower, so it
 * reserves nothing. The one rule every sheet header reads, so a header cannot
 * disagree with the detent that presents the sheet.
 *
 * Lives apart from `lib/form-sheet` so that module stays free of the navigation
 * context that only the deciding callers need.
 */
export function useFormSheetHeaderTopInset(): SheetHeaderTopInset {
  return useRouteIsStackRoot() ? 'android-window-top' : 'bottom-form-sheet';
}
