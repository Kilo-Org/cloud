import { useState } from 'react';
import { type LayoutChangeEvent, type ViewStyle } from 'react-native';

// A first page that settles into a body shorter than its loading placeholder
// shrinks the slot and pulls the section below it up after the screen has
// already settled — the PR Review inbox measured a 69 dp move of its RECENT
// section when five skeleton rows became the reconnect card. The slot therefore
// remembers the height the placeholder itself laid out and keeps it for every
// settled body, so the reservation cannot drift from the rows it replaces.
//
// The placeholder measures itself: no consumer hard-codes a height, and a change
// to the skeleton's rows moves the reservation with it.

type EmptySlot = {
  /** Records the placeholder's height while it is the body. */
  handleLayout: (event: LayoutChangeEvent) => void;
  /** Applies the recorded height to a settled body; absent before any measure. */
  style: ViewStyle | undefined;
};

export function useEmptySlotHeight(loading: boolean): EmptySlot {
  const [height, setHeight] = useState(0);
  return {
    handleLayout: event => {
      if (!loading) {
        return;
      }
      const measured = event.nativeEvent.layout.height;
      setHeight(current => (current === measured ? current : measured));
    },
    // The placeholder keeps its own height: only a settled body reserves.
    style: loading || height === 0 ? undefined : { minHeight: height },
  };
}
