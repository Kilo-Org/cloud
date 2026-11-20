import { useCallback, useRef } from 'react';

import {
  commitResolvedModelPickerSelection,
  type ModelPickerBridge,
  type ModelPickerSelection,
} from '@/lib/picker-bridge';
import { modelPickerSlot, type RouteKey } from '@/lib/route-registry';

/** One pick a picker sheet is holding until its close. */
export type ModelPickerPick = {
  /** The bridge the pick was made through. */
  bridge: ModelPickerBridge;
  /** The selection the row press resolved, against the catalog it drew. */
  selection: ModelPickerSelection;
};

/**
 * The pick an open picker sheet is holding, and the one transition that commits
 * it. The pick belongs to the sheet, not to the route slot: a blur, the re-focus
 * after it, or a caller that registers its bridge again while the sheet is open
 * leaves the person's pick exactly as they left it.
 */
export function useModelPickerPick(routeKey: RouteKey) {
  const pendingPickRef = useRef<ModelPickerPick | null>(null);

  // The pick the sheet is holding now, so a chip press can extend it.
  const heldPick = useCallback(() => pendingPickRef.current, []);

  const holdPick = useCallback((bridge: ModelPickerBridge, selection: ModelPickerSelection) => {
    pendingPickRef.current = { bridge, selection };
  }, []);

  // A picker showing another route's pick belongs to that route, not to this
  // sheet.
  const clearPick = useCallback(() => {
    pendingPickRef.current = null;
  }, []);

  // The close that keeps the pick. Every other way out — Cancel, Android Back,
  // an iOS swipe-down — never calls this, so the caller keeps its model.
  const commitPick = useCallback(() => {
    const pick = pendingPickRef.current;
    pendingPickRef.current = null;
    if (pick === null) {
      return;
    }

    // The caller's latest bridge owns the pick: a composer that registered
    // again while the sheet was open holds the live accept, while the bridge
    // the sheet opened with may have gone with it. A slot cleared under the
    // sheet (its own blur clears it) leaves the pick's bridge to commit it.
    commitResolvedModelPickerSelection(
      modelPickerSlot.get(routeKey) ?? pick.bridge,
      pick.selection
    );
  }, [routeKey]);

  return { heldPick, holdPick, clearPick, commitPick };
}
