/**
 * The device's input mode is not part of the app's design.
 *
 * Android draws its keyboard focus highlight over whichever control holds focus
 * while the device is in non-touch mode, and one `adb shell input keyevent` — a
 * session typing into a field, a Back press — leaves every later run in that
 * mode. Screenshots then show a filled block behind the sheet header's Cancel or
 * a circle behind a screen header's back control, which reads as a stuck pressed
 * state even though the app paints nothing at rest and no touch user sees it.
 * Touch mode comes back with the next touch, so the gate taps one point that no
 * control owns before it opens a link, and the capture shows the app.
 */
import type { ProbeDump } from './tree';

type TouchDevice = Readonly<{ tap?: (xPx: number, yPx: number) => void }>;
export type TouchContext = Readonly<{ device: TouchDevice; log: (line: string) => void }>;

/** Roles whose host view consumes the tap that gives it focus. */
const PRESSING_ROLES: Readonly<Record<string, true>> = {
  button: true,
  checkbox: true,
  link: true,
  menuitem: true,
  option: true,
  radio: true,
  switch: true,
  tab: true,
};

/** Host tags that take a tap themselves, whether or not the dump marks a press. */
const PRESSING_TAGS: Readonly<Record<string, true>> = {
  AndroidSwitch: true,
  AndroidTextInput: true,
  RCTSinglelineTextInputView: true,
  RCTSwitch: true,
  TextInput: true,
};

/** Clearance around a control, so the tap does not land in its `hitSlop`. */
const CONTROL_CLEARANCE_DP = 8;
/**
 * The system's own gesture bands: the status bar above (a tap there opens the
 * shade, so the search starts below it) and the navigation bar below.
 */
const SYSTEM_TOP_DP = 32;
const SYSTEM_BOTTOM_DP = 48;
/** The raster the point is searched on, in dp. */
const STEP_DP = 4;

function pressesControl(node: ProbeDump['nodes'][number]): boolean {
  if (node.pressable === true) {
    return true;
  }
  if (node.role !== undefined && PRESSING_ROLES[node.role] === true) {
    return true;
  }
  return PRESSING_TAGS[node.tag] === true;
}

function claims(rect: readonly number[], x: number, y: number): boolean {
  const [left, top, width, height] = rect as [number, number, number, number];
  return (
    x >= left - CONTROL_CLEARANCE_DP &&
    x <= left + width + CONTROL_CLEARANCE_DP &&
    y >= top - CONTROL_CLEARANCE_DP &&
    y <= top + height + CONTROL_CLEARANCE_DP
  );
}

/**
 * A point no control claims, searched outward from the top-left so it lands in
 * padding or background rather than in the middle of a pressable row.
 */
export function emptyTouchPoint(dump: ProbeDump): { x: number; y: number } | undefined {
  const top = SYSTEM_TOP_DP;
  const bottom = dump.env.window.height - SYSTEM_BOTTOM_DP;
  if (bottom <= top) {
    return undefined;
  }
  const claimed = dump.nodes.filter(pressesControl).map(node => node.rect);
  for (let y = top; y < bottom; y += STEP_DP) {
    for (let x = STEP_DP / 2; x < dump.env.window.width; x += STEP_DP) {
      if (!claimed.some(rect => claims(rect, x, y))) {
        return { x, y };
      }
    }
  }
  return undefined;
}

/** Return Android to touch mode, so the next capture shows the app, not a focus ring. */
export function enterTouchMode(ctx: TouchContext, dump: ProbeDump): void {
  if (dump.env.platform !== 'android' || ctx.device.tap === undefined) {
    return;
  }
  const point = emptyTouchPoint(dump);
  if (point === undefined) {
    ctx.log('design-gate: every point belongs to a control; the device keeps its input mode');
    return;
  }
  const pixelRatio = dump.env.pixelRatio;
  ctx.device.tap(point.x * pixelRatio, point.y * pixelRatio);
}
