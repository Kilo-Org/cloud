/**
 * A code point a reader can see. A separator, a control, a zero-width or
 * direction mark, or a combining mark draws nothing on its own, so a composer
 * value made of them is as empty as one made of spaces. A code point this
 * engine's Unicode tables do not classify yet matches (it is neither Cc, Cf, Z
 * nor M), so a message that is a brand-new emoji stays a message.
 */
const RENDERS = /[^\p{Cc}\p{Cf}\p{Z}\p{M}]/u;

/**
 * Fillers that draw nothing and are still letters or symbols by category: the
 * Hangul fillers and the braille blank. They are the shapes a "blank" message is
 * usually padded with.
 */
const INVISIBLE_FILLER = /[\u115F\u1160\u2800\u3164\uFFA0]/u;

/**
 * Whether a composer value carries anything a reader can see.
 *
 * `String.prototype.trim()` answers a narrower question: it removes Unicode
 * whitespace and keeps the zero-width and control characters that draw nothing,
 * which is how a draft of spaces and zero-width spaces looked empty on screen
 * and still sent. Every composer gate reads this instead, so the send button,
 * the send handler and the start-session path agree on what a blank message is.
 */
export function hasVisibleComposerText(value: string): boolean {
  for (const character of value) {
    if (!INVISIBLE_FILLER.test(character) && RENDERS.test(character)) {
      return true;
    }
  }
  return false;
}

/**
 * The prompt a composer draft stands for: its text without the surrounding
 * whitespace, or the empty string when the draft holds nothing a reader can
 * see. The send path admits on this and the clear-after-send guard compares
 * with it, so a draft of invisible characters is the same empty prompt in both
 * places instead of a value that can never match what was sent.
 */
export function composerPromptText(value: string): string {
  return hasVisibleComposerText(value) ? value.trim() : '';
}
