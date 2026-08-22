import { type ContinuationDestination } from '@/components/agents/continuation-seed';

type ContinuePickerBridge = {
  destinations: ContinuationDestination[];
  /** Runs when the user taps a row. */
  onSelect: (destination: ContinuationDestination) => void;
  /** Runs when the sheet closes with no pick, so the caller can drop its busy lock. */
  onCancel: () => void;
};

/**
 * Invariant: `useContinueSession` is the only producer, and it sets the bridge
 * only on the `destinations.length > 1` branch. A present bridge therefore
 * always holds two or more destinations, so the picker needs no empty state.
 */
let bridge: ContinuePickerBridge | null = null;

export function getContinuePickerBridge() {
  return bridge;
}
export function clearContinuePickerBridge() {
  bridge = null;
}
