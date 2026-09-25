import { createContext, useContext } from 'react';

/**
 * Whether the band a centered state is laid out in is a short one — a phone
 * held sideways.
 *
 * A centered state is handed the band the page leaves between its header and
 * the fixed bottom tab bar, and that band is only a fraction of a phone's
 * height while the window is wider than it is tall. A state whose full stack
 * does not fit asks this and drops decoration the band cannot hold.
 *
 * The scroller that owns the band publishes the answer, so a state only reads
 * it; nothing outside a scroller is short. It lives in its own module because
 * every mounted test that mocks `@/components/centered-state` mocks that module
 * whole, and a state inside such a mock is laid out by the caller, not by a
 * measured band.
 */
const ShortCenteredBandContext = createContext(false);

export function useShortCenteredBand(): boolean {
  return useContext(ShortCenteredBandContext);
}

export const ShortCenteredBandProvider = ShortCenteredBandContext.Provider;
