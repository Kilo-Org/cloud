import type { Part, FilePart, StepFinishPart, ToolPart } from './types';

function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

function stripFilePartContent(part: FilePart): FilePart {
  const stripped: FilePart = {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'file',
    mime: part.mime,
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
    url: '',
  };
  if (part.source) {
    stripped.source = {
      ...part.source,
      text: {
        ...part.source.text,
        value: '',
      },
    };
  }
  return stripped;
}

export function stripPartContentIfFile(part: Part): Part {
  if (isFilePart(part)) {
    return stripFilePartContent(part);
  }
  if (isToolPart(part) && part.state.status === 'completed' && part.state.attachments) {
    const strippedAttachments = part.state.attachments.map(stripFilePartContent);
    return {
      ...part,
      state: {
        ...part.state,
        attachments: strippedAttachments,
      },
    };
  }
  return part;
}

/**
 * The generated `Part` types declare `text: string` on text and reasoning
 * parts, but the wire can omit the field (the per-event schemas are
 * `.passthrough()`), and a textless part stored verbatim crashes every mobile
 * reader (`part.text.trim()` — Sentry KILO-APP-99). Normalize once at the
 * chat-processor seam — the single funnel every part write goes through — so
 * all downstream readers see a string.
 *
 * Identity-preserving: when nothing needs fixing the SAME object is returned
 * so memoized stored messages keep their reference. Whitespace-only text is
 * left untouched; only absent or non-string text is filled with `''`.
 */
export function normalizeMissingPartText(part: Part): Part {
  if (part.type !== 'text' && part.type !== 'reasoning') {
    return part;
  }
  if (typeof part.text === 'string') {
    return part;
  }
  return { ...part, text: '' };
}

/**
 * The concrete routed model stamped by the CLI onto step-finish parts for
 * kilo-auto turns (`{ providerID, modelID }`). Preserved at runtime on both
 * the live-stream path (`messagePartUpdatedDataSchema` uses `.passthrough()`)
 * and the history-load path (mirrored in `kiloSdkPartSchema` step-finish
 * variant). Absent from the externally generated `StepFinishPart` type
 * (`apps/web/src/types/opencode.gen.ts` cannot be regenerated in-repo), so
 * read the field through {@link getStepFinishRoutedModel}.
 */
export type RoutedModelRef = { providerID: string; modelID: string };

/**
 * Read the concrete routed model off a step-finish part if present and
 * well-formed. Returns `undefined` when the field is absent, null, or
 * malformed (non-string or empty `providerID` / `modelID`), so callers never
 * receive a partial object. The single documented cast is confined to this
 * function: the field exists on the wire and in the Zod contract but is not
 * declared on the generated `StepFinishPart` type alias (type-alias members
 * of a union cannot be merged via module augmentation).
 */
export function getStepFinishRoutedModel(part: StepFinishPart): RoutedModelRef | undefined {
  const model = (part as { model?: unknown }).model;
  if (!model || typeof model !== 'object') return undefined;
  const { providerID, modelID } = model as { providerID?: unknown; modelID?: unknown };
  if (typeof providerID !== 'string' || providerID.length === 0) return undefined;
  if (typeof modelID !== 'string' || modelID.length === 0) return undefined;
  return { providerID, modelID };
}
