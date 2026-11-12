/**
 * The gap between the model chat's name and the notice beside it, in dp
 * (`gap-2`, half NativeWind's 14dp rem). Measured on the header: the name ends
 * at 84.95dp and the notice starts at 91.81dp, so the row keeps 6.86dp and
 * rounds to 7.
 */
export const CHAT_TITLE_NOTICE_GAP_DP = 7;

/**
 * Slack kept between the notice's end edge and the header slot's end edge, in
 * dp: about one device pixel, so a title that fits only after a sub-pixel
 * rounding keeps the notice instead of losing a glyph's worth of width.
 */
const TITLE_NOTICE_SLACK_DP = 0.5;

/**
 * Whether the header can show the title whole beside its notice.
 *
 * The title is the screen's name and the notice is a label about the screen, so
 * the notice yields first: `apps/mobile/AGENTS.md` requires that secondary text
 * is dropped before the primary text is squeezed, and a "C…" heading beside a
 * whole BETA pill reads as a header that cannot say which screen it is.
 *
 * `slot` is the room the title group has, `title` the title's own width and
 * `notice` the notice's own width. Widths are what the caller measured, never a
 * worst case: a title longer than the slot reports the slot, which fails every
 * fit test and so yields the notice exactly like a measured overflow.
 */
export function titleKeepsNotice({
  slot,
  title,
  notice,
}: Readonly<{ slot: number; title: number; notice: number }>): boolean {
  return title + CHAT_TITLE_NOTICE_GAP_DP + notice <= slot - TITLE_NOTICE_SLACK_DP;
}
