import { isolateLtrBidiText } from '@/lib/bidi';

/**
 * One backticked inline-code run. A lone backtick (an authoring slip) matches
 * the empty alternative so the marker still never reaches the reader.
 */
const INLINE_CODE = /`([^`]*)`|`/g;

/**
 * Plain copy for a native `Text`. The catalogs mark commands and paths with
 * backticks, and nothing in the app renders that markup, so the reader sees the
 * punctuation itself. English ships without markers; the translation slice
 * removes them from the other catalogs, and this keeps those readable first.
 *
 * A marked run is a command or a path, so it renders as one isolated
 * left-to-right run (`isolateLtrBidiText`): in a right-to-left paragraph the
 * run then keeps its own order instead of splitting against the sentence
 * around it, and the punctuation outside the isolate still belongs to the
 * sentence — `kilo remote`. keeps its period at the end of the sentence.
 */
export function stripInlineCodeMarkers(value: string): string {
  return value.replaceAll(INLINE_CODE, (_match, run?: string) =>
    run === undefined ? '' : isolateLtrBidiText(run)
  );
}
