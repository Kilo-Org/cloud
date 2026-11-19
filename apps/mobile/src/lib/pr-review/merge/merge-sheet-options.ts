/**
 * The merge sheet's detents: on Android, only the full one.
 *
 * Android lays a formSheet route's content out at its largest detent, not at
 * the detent it presents (see `apps/mobile/AGENTS.md`). The merge sheet opens
 * at the full detent, but a drag to the half detent then shows only the top of
 * a full-height layout: its viewport still reads as full, so the compact
 * half-detent form never applies, and the Merge button sits below the half
 * sheet's edge, where it can be neither scrolled into view nor pressed. The
 * form measured about 545 dp against a half detent of about 457 dp. One
 * detent removes the half position, so the action stays on screen. iOS lays
 * the content out at the presented detent and keeps both.
 */
export function prMergeSheetOptions<T extends { sheetAllowedDetents: readonly number[] }>(
  options: T,
  os: string
): Omit<T, 'sheetAllowedDetents'> & { sheetAllowedDetents: number[] } {
  const detents = [...options.sheetAllowedDetents];
  const full = detents.at(-1);
  if (os !== 'android' || full === undefined) {
    return { ...options, sheetAllowedDetents: detents };
  }
  return { ...options, sheetAllowedDetents: [full] };
}
