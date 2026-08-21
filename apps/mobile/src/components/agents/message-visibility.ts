import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import {
  isCompactionPart,
  isFilePart,
  isPatchPart,
  isReasoningPart,
  isSnapshotProgressPart,
  isTextPart,
  isToolPart,
  shouldRenderReasoningPart,
} from './part-types';

/**
 * Whether `PartRenderer` renders visible content for this part.
 *
 * `PartRenderer` is the only consumer of the null cases, so this predicate is the
 * single source for "renders nothing": the renderer gates on it, and the transcript
 * builder drops a message that has no content and never puts a time marker above it.
 */
export function partRendersContent(part: Part): boolean {
  if (isTextPart(part)) {
    // Snapshot-init progress shows only in the fixed WorkingIndicator row, and
    // TextPartRenderer renders nothing for blank text. Whitespace-only text is
    // blank: markdown draws no ink for it, so counting it as content adds a
    // zero-height row that eats a transcript gap and doubles the visible one.
    return !isSnapshotProgressPart(part) && part.text.trim() !== '';
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
  return isFilePart(part) || isCompactionPart(part) || (isPatchPart(part) && part.files.length > 0);
}

/**
 * Whether the message renders anything in the transcript. A user message always
 * renders its bubble; an assistant message renders only what its parts render.
 */
export function messageRendersContent(message: StoredMessage): boolean {
  return message.info.role === 'user' || message.parts.some(partRendersContent);
}
