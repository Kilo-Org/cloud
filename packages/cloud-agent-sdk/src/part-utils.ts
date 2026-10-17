import type { Part, FilePart, StepFinishPart, ToolPart, ToolState } from './types';

function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

/**
 * A tool part's `state`, validated well enough to read. The wire and the
 * replay paths do not guarantee the field: the per-event schema checks the
 * part's identity, and a replay hands stored parts to the seam, so `state` can
 * be absent, null, a non-object, or carry a `status` that is not a string even
 * though the generated `ToolPart` declares a full `ToolState`. Returns `null`
 * for all of those, so callers skip a part they cannot read.
 *
 * The declared union cannot be recovered by narrowing (`in`/`typeof` give an
 * object with unknown members); it is then trusted only for the members each
 * reader validates for itself — `status`, `Array.isArray(attachments)`, and a
 * numeric `time.end`.
 */
function toolStateOf(part: ToolPart): ToolState | null {
  const state: unknown = part.state;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  if (!('status' in state) || typeof state.status !== 'string' || state.status.length === 0) {
    return null;
  }
  const validated: ToolState = state as ToolState;
  return validated;
}

/**
 * A tool attachment entry the chat pipeline can read. `mime` is passed to
 * `startsWith` and `url` is the data URL handed to the attachment sink, so the
 * predicate checks both; anything else the entry carries is a file part's field
 * on the wire and is preserved when the stored part is written back, but is not
 * claimed here.
 */
type ReadableToolAttachment = { mime: string; url: string } & Partial<FilePart>;

function isToolAttachment(attachment: unknown): attachment is ReadableToolAttachment {
  if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment)) {
    return false;
  }
  if (!('mime' in attachment) || typeof attachment.mime !== 'string') return false;
  if (!('url' in attachment) || typeof attachment.url !== 'string') return false;
  return true;
}

/**
 * The stored form of one tool attachment: the bytes (`url`) and the source text
 * are dropped, the entry's other fields are kept.
 *
 * The assertion restores the declared slot type: `ToolStateCompleted.attachments`
 * is `Array<FilePart>`, and the entry came from that list, while this seam
 * validates only the members the pipeline reads (`isToolAttachment`).
 */
function stripToolAttachmentContent(attachment: ReadableToolAttachment): FilePart {
  const stripped = { ...attachment, url: '' };
  const source = stripped.source;
  if (
    typeof source === 'object' &&
    source !== null &&
    'text' in source &&
    typeof source.text === 'object' &&
    source.text !== null &&
    'value' in source.text
  ) {
    stripped.source = { ...source, text: { ...source.text, value: '' } };
  }
  return stripped as FilePart;
}

/**
 * The attachments of a completed tool part that downstream consumers can use,
 * or an empty list. Empty for every other `state.status`, and for a part whose
 * `state` or `state.attachments` is not usable, so every consumer reads a plain
 * list of readable entries.
 */
export function toolPartAttachments(part: Part): readonly ReadableToolAttachment[] {
  if (!isToolPart(part)) return [];
  const state = toolStateOf(part);
  if (state === null || state.status !== 'completed' || !Array.isArray(state.attachments)) {
    return [];
  }
  return state.attachments.filter(isToolAttachment);
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
  if (isToolPart(part)) {
    const state = toolStateOf(part);
    if (state !== null && state.status === 'completed' && Array.isArray(state.attachments)) {
      const strippedAttachments = state.attachments
        .filter(isToolAttachment)
        .map(stripToolAttachmentContent);
      return {
        ...part,
        state: {
          ...state,
          attachments: strippedAttachments,
        },
      };
    }
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
 * Settle time a stored tool part carries into the lifecycle merge. Snapshot,
 * history and cached-transcript replays deliver bare parts with no wire event
 * time, so a settled tool state is ordered by the `time.end` it stamped when it
 * settled. An unsettled part carries no ordering evidence.
 *
 * The state is read defensively at every level: a part arriving from the wire
 * or a replay can carry no usable `state` at all, and ingest-frame compaction
 * persists a part with only `state.status`
 * (`services/cloud-agent-next/src/shared/ingest-frame.ts` `compactMessagePart`),
 * so a replayed terminal can arrive with no time. Either case carries no
 * ordering evidence.
 */
export function partSettledAt(part: Part): number | undefined {
  if (part.type !== 'tool') return undefined;
  const state = toolStateOf(part);
  if (state === null) return undefined;
  if (state.status === 'completed' || state.status === 'error') {
    const end = state.time?.end;
    return typeof end === 'number' ? end : undefined;
  }
  return undefined;
}

/**
 * The generated `Part` types declare `files: Array<string>` on patch parts, but
 * the wire can omit the field (the per-event schemas are `.passthrough()`), and
 * a files-less part stored verbatim crashes every mobile reader
 * (`part.files.length` — Sentry KILO-APP-BZ). Normalize once at the
 * chat-processor seam — the single funnel every part write goes through — so
 * all downstream readers see an array. A missing list and an empty one mean the
 * same thing to a reader: the standalone patch part carries only file paths, so
 * there is nothing to draw.
 *
 * Identity-preserving: when nothing needs fixing the SAME object is returned
 * so memoized stored messages keep their reference.
 */
export function normalizeMissingPatchFiles(part: Part): Part {
  if (part.type !== 'patch') {
    return part;
  }
  if (Array.isArray(part.files)) {
    return part;
  }
  return { ...part, files: [] };
}

/**
 * A tool part's `state` decides how every reader treats the part: the stored
 * lifecycle merge ranks `state.status`, the transcript renders the completed
 * output, and the attachment sink reads `state.attachments[].mime`. The wire
 * and the replay paths do not guarantee any of it (the per-event schema is
 * `.passthrough()`, and a replay hands stored parts to this seam), so a part
 * can arrive with no `state`, a null one, or a `state.status` that is not a
 * string.
 *
 * Such a part is DROPPED (returns `null`): nothing renderable is lost, no state
 * is invented for it, and skipping the write leaves any previously stored good
 * version of the same part id in place instead of replacing it with an
 * unreadable one. A part with a usable `status` is kept, with
 * `state.attachments` reduced to the entries downstream consumers can read.
 *
 * Identity-preserving: when nothing needs fixing the SAME object is returned
 * so memoized stored messages keep their reference.
 */
export function normalizeToolPartState(part: Part): Part | null {
  if (!isToolPart(part)) {
    return part;
  }
  const state = toolStateOf(part);
  if (state === null) {
    return null;
  }
  if (state.status !== 'completed') {
    return part;
  }
  const attachments = state.attachments;
  if (attachments === undefined) {
    return part;
  }
  if (!Array.isArray(attachments)) {
    return { ...part, state: { ...state, attachments: [] } };
  }
  const conforming = attachments.filter(isToolAttachment);
  if (conforming.length === attachments.length) {
    return part;
  }
  return { ...part, state: { ...state, attachments: conforming } };
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
