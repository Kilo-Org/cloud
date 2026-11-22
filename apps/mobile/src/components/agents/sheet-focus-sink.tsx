import { Text } from '@/components/ui/text';

/**
 * A presented sheet's focus sink: it takes the focus a sheet window hands to its
 * first focusable node, so the content below it is never the focus owner.
 *
 * Android paints a focus layer over the whole rect of whichever view holds
 * focus. A selectable `Text` is focusable — `setTextIsSelectable` sets the
 * focusable flag — so a read-only value rendered as one carried that layer at
 * rest and showed it as a second, sharp-cornered strip inside its field. The
 * layer cannot be switched off from React Native, and the value loses its
 * long-press selection when the node stops being focusable, so the focus has to
 * land somewhere harmless instead.
 *
 * The sink is that place. It must be `selectable` rather than a plain focusable
 * `View`: a sheet window opens in touch mode, and only a focusable-in-touch-mode
 * node takes the focus there. It paints nothing — fully transparent, one pixel,
 * out of flow — takes no touch (`setTextIsSelectable` also makes a text view
 * clickable, which `pointerEvents` turns off), and is hidden from assistive
 * readers with the two flags each platform reads, so it never becomes a focus
 * stop a screen reader announces.
 *
 * Render it once, before the sheet's content.
 */
export function SheetFocusSink() {
  return (
    <Text
      selectable
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      allowFontScaling={false}
      className="absolute size-px opacity-0"
    />
  );
}
