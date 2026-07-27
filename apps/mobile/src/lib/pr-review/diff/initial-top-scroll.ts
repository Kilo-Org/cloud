// One-shot scroll-to-top after the Files list first lays out real content.
//
// Arm on the first `files.length > 0` transition per mount; fire only from a
// subsequent content-size callback with positive height so FlashList has laid
// out the new items. Never re-fires on page appends.

export type InitialTopScrollState =
  | { readonly status: 'idle' }
  | { readonly status: 'armed' }
  | { readonly status: 'done' };

export const INITIAL_TOP_SCROLL_IDLE: InitialTopScrollState = { status: 'idle' };

/**
 * Arm when real files first become available. No-ops once armed or done so
 * page appends cannot re-arm.
 */
export function armInitialTopScroll(
  state: InitialTopScrollState,
  filesLength: number
): InitialTopScrollState {
  if (state.status !== 'idle') {
    return state;
  }
  if (filesLength <= 0) {
    return state;
  }
  return { status: 'armed' };
}

/**
 * Fire scroll-to-top once content reports a positive height after arming.
 * Returns whether the caller should invoke `scrollToOffset({ offset: 0 })`.
 */
export function onInitialTopScrollContentSize(
  state: InitialTopScrollState,
  contentHeight: number
): { readonly state: InitialTopScrollState; readonly shouldScroll: boolean } {
  if (state.status !== 'armed') {
    return { state, shouldScroll: false };
  }
  if (contentHeight <= 0) {
    return { state, shouldScroll: false };
  }
  return { state: { status: 'done' }, shouldScroll: true };
}
