import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { INPUT_FRAME_CLASS } from '@/components/ui/input-frame';
import { cn } from '@/lib/utils';

/**
 * The surface a read-only value sits on inside a tool part sheet: the same
 * preview box a read-only single-line field uses (`INPUT_BOX_SHAPE_CLASS` and
 * `INPUT_FRAME_CLASS`), so the two boxes cannot drift apart.
 *
 * Android draws its default focus highlight over the whole rect of the focused
 * view. A selectable `Text` is focusable — `TextView.setTextIsSelectable` calls
 * `setFocusableInTouchMode(true)` and `setFocusable(FOCUSABLE_AUTO)` — and the
 * part sheet gives the first of those nodes focus when it opens, so the value
 * would otherwise paint a sharp-cornered band flush to its text (`ScreenHeader`
 * clips the same platform layer on its back control). Here the band lands
 * inside a designed field instead.
 */
export const TOOL_VALUE_SURFACE_CLASS = cn(
  INPUT_BOX_SHAPE_CLASS,
  INPUT_FRAME_CLASS,
  'justify-center py-2.5'
);
