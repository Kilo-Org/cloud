/**
 * What no filename may carry.
 *
 * - `/` and `\` are path separators: a name that keeps one is a path, not a
 *   name.
 * - `\p{Cc}` is every Unicode control character: the C0 range
 *   (`\u0000-\u001F`), DEL (`\u007F`) and the C1 block (`\u0080-\u009F`). They
 *   are drawn as nothing or as a cursor move, so a name holding one shows less
 *   than it is.
 * - `\u202A-\u202E` are the bidi embeddings and overrides and `\u2066-\u2069`
 *   the isolates. A right-to-left override inside a name makes it display as a
 *   different name: `invoice\u202Etxt.exe` reads as `invoiceexe.txt`, so the
 *   person choosing where a file goes is deciding on a name it does not have.
 */
const UNSAFE_FILENAME_CHARACTERS = /[/\\\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/** The leading directory of a path, its final separator included. */
const DIRECTORY_PREFIX = /^.*[/\\]/u;

/**
 * `raw` as a filename: the basename of whatever path it arrived in, with every
 * character that cannot be displayed or written safely removed.
 *
 * Every remaining character passes through unchanged — a space, an accent, a
 * CJK or an Arabic letter — so a person's `Rechnung-März.pdf` keeps its name.
 * Nothing here trims, truncates or falls back; the caller that needs a
 * non-empty, bounded result owns that.
 */
export function stripUnsafeFilenameCharacters(raw: string): string {
  return raw.replace(DIRECTORY_PREFIX, '').replace(UNSAFE_FILENAME_CHARACTERS, '');
}
