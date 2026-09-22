/**
 * Maximum font scale honoured by the tour step headers.
 *
 * Each step opens with an icon tile, an `h3` title and a `text-base` body.
 * On a small screen at Android's maximum system font scale (274x487 dp at
 * font_scale 2.0) the body alone grows past the space between the header
 * block and the Skip/Done bar, so the step opens with the subtitle's last
 * line cut mid-glyph at the scroll fold — it reads as broken text, not as
 * scrollable content. Capped at 1.6 the body stays within four bounded
 * lines, the whole header block fits above the fold, and the fold lands in
 * the scrollable content slot below instead.
 *
 * Unlike the PR diff (whose 1.4 cap keeps a monospace grid aligned to
 * fixed row metrics), the header only needs to fit the fold, so the cap is
 * the highest multiplier that still does: scales below 1.6 pass through
 * untouched and a11y users keep most of their preferred scale.
 */
export const TOUR_HEADER_MAX_FONT_SCALE = 1.6;
