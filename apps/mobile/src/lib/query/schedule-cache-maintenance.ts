import { InteractionManager } from 'react-native';

/**
 * Run cache maintenance after the current interactions settle, so a
 * navigation frame never waits on it.
 */
export function scheduleCacheMaintenance(run: () => void): void {
  // eslint-disable-next-line typescript-eslint/no-deprecated -- InteractionManager.runAfterInteractions is the documented API for deferring work past the current interaction frame.
  InteractionManager.runAfterInteractions(run);
}
