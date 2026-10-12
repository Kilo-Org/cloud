import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import {
  hasNonWhitespaceText,
  isCompactionPart,
  isFilePart,
  isPatchPart,
  isReasoningPart,
  isSnapshotProgressPart,
  isTextPart,
  isToolPart,
  shouldRenderReasoningPart,
} from './part-types';
import { htmlSanitizesToEmpty } from './markdown-html-sanitization';

// Parts are immutable: the session storage replaces a part object on every
// change and keeps the object of an unchanged part. The transcript builders ask
// this predicate for every part on every streamed frame, and for text it scans
// the whole text (and runs the HTML sanitizer when the text holds a `<`), so a
// cache per part object turns that per-frame scan of the whole transcript into
// one scan per part version.
const rendersContentByPart = new WeakMap<Part, boolean>();

/**
 * Whether `PartRenderer` renders visible content for this part.
 *
 * `PartRenderer` is the only consumer of the null cases, so this predicate is the
 * single source for "renders nothing": the renderer gates on it, and the transcript
 * builder drops a message that has no content and never puts a time marker above it.
 */
export function partRendersContent(part: Part): boolean {
  let rendersContent = rendersContentByPart.get(part);
  if (rendersContent === undefined) {
    rendersContent = computePartRendersContent(part);
    rendersContentByPart.set(part, rendersContent);
  }
  return rendersContent;
}

function computePartRendersContent(part: Part): boolean {
  if (isTextPart(part)) {
    // Snapshot-init progress shows only in the fixed WorkingIndicator row, and
    // TextPartRenderer renders nothing for blank text. Whitespace-only text is
    // blank: markdown draws no ink for it, so counting it as content adds a
    // zero-height row that eats a transcript gap and doubles the visible one.
    return (
      !isSnapshotProgressPart(part) &&
      hasNonWhitespaceText(part.text) &&
      !htmlSanitizesToEmpty(part.text)
    );
  }
  if (isToolPart(part)) {
    // ToolPartRenderer renders nothing for the plan-mode transition tools.
    return part.tool !== 'plan_enter' && part.tool !== 'plan_exit';
  }
  if (isReasoningPart(part)) {
    // The second argument is unused by shouldRenderReasoningPart; visibility is a
    // property of the part, not of the stream.
    return shouldRenderReasoningPart(part, false);
  }
  // A patch part whose `files` the wire omitted means the same as an empty one:
  // nothing to draw. The generated type declares the array unconditionally
  // (the live per-event schemas are `.passthrough()`), so the runtime shape is
  // read through a declared optional. The chat processor fills the array, but a
  // part can still reach a reader unfixed (a unit caller, a stored part from an
  // older build), and a throw here replaces the whole app with the error
  // boundary (Sentry KILO-APP-BZ).
  const files = (part as { files?: readonly string[] }).files;
  return (
    isFilePart(part) || isCompactionPart(part) || (isPatchPart(part) && (files ?? []).length > 0)
  );
}

/**
 * Whether the message renders anything in the transcript. Keep the transient
 * zero-part user row, but drop a user row whose parts sanitize to no content.
 */
export function messageRendersContent(message: StoredMessage): boolean {
  return (
    (message.info.role === 'user' && message.parts.length === 0) ||
    message.parts.some(partRendersContent)
  );
}
