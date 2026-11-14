import { hasVisibleText } from '@kilocode/app-shared/text';

/**
 * Whether a composer value carries anything a reader can see.
 *
 * `String.prototype.trim()` answers a narrower question: it removes Unicode
 * whitespace and keeps the zero-width and control characters that draw nothing,
 * which is how a draft of spaces and zero-width spaces looked empty on screen
 * and still sent. Every composer gate reads this instead, so the send button,
 * the send handler and the start-session path agree on what a blank message is.
 *
 * The rule itself lives in `hasVisibleText` (packages/app-shared/src/text.ts):
 * a code point a reader can see, minus the categories and fillers that draw
 * nothing. The organization name gates read the same helper, so every field,
 * button and server answers "did the person write anything?" the same way.
 */
export function hasVisibleComposerText(value: string): boolean {
  return hasVisibleText(value);
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
