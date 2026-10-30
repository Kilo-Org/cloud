import type { Finding } from '../findings';
import type { Rgba } from '../pixels';
import type { LayoutTree } from '../tree';
import { checkInkCentering } from './ink';
import { checkInsetAsymmetry } from './inset';
import {
  checkClipped,
  checkCutOff,
  checkOverlap,
  checkRowAlignment,
  checkSafeArea,
  checkTouchOverlap,
  checkTouchTargets,
} from './screen';

export { normalize } from '../tree';
export { checkMirror } from './mirror';
export { checkShift } from './shift';

export function checkScreen(tree: LayoutTree, image?: Rgba): Finding[] {
  return [
    ...checkClipped(tree),
    ...checkCutOff(tree),
    ...checkTouchOverlap(tree),
    ...checkOverlap(tree),
    ...checkRowAlignment(tree),
    ...(image ? checkInkCentering(tree, image) : []),
    ...checkTouchTargets(tree),
    ...checkInsetAsymmetry(tree),
    ...checkSafeArea(tree),
  ];
}
