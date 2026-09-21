import { createContext, useContext } from 'react';

/**
 * Height of the band a `CenteredState` is centering its content in, or null
 * outside a measured one. A state whose full form cannot fit the band reads
 * this and renders its compact form instead of overflowing behind the bottom
 * overlay (landscape spot defect e8: the Agents no-match state's second line
 * and action were parked under the tab bar).
 *
 * It lives in its own module so a test that mocks `centered-state` (the
 * component) still resolves the hook: the consumer renders inside the mocked
 * component and simply reads the default null, keeping the full form.
 */
export const CenteredStateBandContext = createContext<number | null>(null);

export function useCenteredStateBand() {
  return useContext(CenteredStateBandContext);
}
