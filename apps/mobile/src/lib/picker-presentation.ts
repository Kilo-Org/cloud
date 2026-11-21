/**
 * Whether the account picker sheet is on screen.
 *
 * The presented `(app)/context-picker` route owns the answer: it marks itself
 * present when it mounts and releases when it unmounts, so the mark is true
 * exactly while a copy of the sheet exists, whichever navigator presented it.
 * Every opener reads it before it pushes, so a second open cannot stack another
 * copy that needs its own Done.
 *
 * A module-level count, like the route registry's maps, and not React state: an
 * opener reads it from a press handler rather than from a render, and a
 * subscription here would re-render every account control in the app each time
 * the sheet opens or closes.
 *
 * The route mounts one frame after the push that presented it. The per-burst
 * guard in `useSinglePushRoute` covers that frame, and it is the only window
 * this mark leaves open.
 */
let presented = 0;

/** Marks the picker presented; the returned release is safe to call once. */
export function enterContextPicker(): () => void {
  presented += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    presented -= 1;
  };
}

export function isContextPickerPresented(): boolean {
  return presented > 0;
}
