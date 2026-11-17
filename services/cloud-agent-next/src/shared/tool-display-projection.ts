/**
 * Display projection for completed tool calls.
 *
 * History pages and stream replay can ask for bounded previews instead of
 * complete tool bodies. The stored row is never changed: the projection runs
 * on read, and the complete row stays available through the separately
 * authorized tool-detail read. A projected tool carries a `cloudDetail` marker
 * so clients can tell a preview from complete data. Omitted bytes are never
 * represented as empty output or deletion.
 *
 * Only completed tools are projected. Running tools keep their live progress
 * and failed tools keep their complete error context.
 */

export const TOOL_DISPLAY_PROJECTION_VERSION = 1;
/** Complete tool outputs up to this many UTF-8 bytes are kept whole. */
export const TOOL_OUTPUT_PREVIEW_BYTES = 1024;
/** Every other string inside tool input or metadata is bounded separately. */
export const TOOL_FIELD_PREVIEW_BYTES = 1024;
export const TOOL_DETAIL_MARKER_FIELD = 'cloudDetail';

const MAX_OMITTED_PATHS = 32;
const MAX_SUMMARY_PATHS = 200;
const MAX_SUMMARY_PATH_LENGTH = 512;
const MAX_DEPTH = 8;

export type ToolDisplayMode = 'full' | 'preview';

export type ToolDetailMarker = {
  version: typeof TOOL_DISPLAY_PROJECTION_VERSION;
  /** The stored row's mutation cursor; a newer revision invalidates fetched details. */
  revision: number;
  /** Bounded list of shortened fields, as dotted paths such as `output` or `input.content`. */
  omitted: string[];
  /** Total number of shortened fields, which can exceed `omitted.length`. */
  omittedCount: number;
  /** Complete UTF-8 size of the shortened values. */
  omittedBytes: number;
  /** Small values derived from shortened fields that collapsed tool rows need. */
  summary?: { paths?: string[] };
};

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Returns the longest prefix of `text` that fits in `maxBytes` UTF-8 bytes,
 * or `undefined` when the whole string fits. Never splits a code point.
 */
export function utf8Preview(text: string, maxBytes: number): string | undefined {
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes.
  if (text.length * 3 <= maxBytes) return undefined;
  const buffer = new Uint8Array(Math.max(0, maxBytes));
  const { read } = encoder.encodeInto(text, buffer);
  if (read >= text.length) return undefined;
  return text.slice(0, read);
}

type Omissions = { paths: string[]; count: number; bytes: number };

function recordOmission(omissions: Omissions, path: string, original: string) {
  omissions.count += 1;
  omissions.bytes += utf8Bytes(original);
  if (omissions.paths.length < MAX_OMITTED_PATHS) omissions.paths.push(path);
}

/** Bounds every string in a JSON value. Returns the same reference when nothing changed. */
function boundStrings(
  value: unknown,
  path: string,
  omissions: Omissions,
  maxBytes: number,
  depth = 0
): unknown {
  if (typeof value === 'string') {
    const preview = utf8Preview(value, maxBytes);
    if (preview === undefined) return value;
    recordOmission(omissions, path, value);
    return preview;
  }
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const bounded = boundStrings(item, `${path}.${index}`, omissions, maxBytes, depth + 1);
      if (bounded !== item) changed = true;
      return bounded;
    });
    return changed ? next : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const bounded = boundStrings(item, `${path}.${key}`, omissions, maxBytes, depth + 1);
      if (bounded !== item) changed = true;
      next[key] = bounded;
    }
    return changed ? next : value;
  }
  return value;
}

const APPLY_PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm;

function applyPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const match of patchText.matchAll(APPLY_PATCH_HEADER)) {
    const path = match[1]?.trim();
    if (!path || path.length > MAX_SUMMARY_PATH_LENGTH) continue;
    paths.add(path);
    if (paths.size >= MAX_SUMMARY_PATHS) break;
  }
  return [...paths];
}

function marker(
  revision: number,
  omissions: Omissions,
  summary: ToolDetailMarker['summary']
): ToolDetailMarker {
  return {
    version: TOOL_DISPLAY_PROJECTION_VERSION,
    revision,
    omitted: omissions.paths,
    omittedCount: omissions.count,
    omittedBytes: omissions.bytes,
    ...(summary === undefined ? {} : { summary }),
  };
}

function patchSummary(
  tool: unknown,
  input: unknown,
  boundedInput: unknown
): ToolDetailMarker['summary'] {
  if (tool !== 'apply_patch' || !isRecord(input) || !isRecord(boundedInput)) return undefined;
  const patchText = input.patchText;
  if (typeof patchText !== 'string' || boundedInput.patchText === patchText) return undefined;
  return { paths: applyPatchPaths(patchText) };
}

/** Projects one v1 Kilo part. Non-tool and non-completed parts are returned unchanged. */
export function projectToolPartForDisplay(part: unknown, revision: number): unknown {
  if (!isRecord(part) || part.type !== 'tool' || !isRecord(part.state)) return part;
  const state = part.state;
  if (state.status !== 'completed') return part;
  const omissions: Omissions = { paths: [], count: 0, bytes: 0 };
  const output =
    typeof state.output === 'string'
      ? boundStrings(state.output, 'output', omissions, TOOL_OUTPUT_PREVIEW_BYTES)
      : state.output;
  const input = boundStrings(state.input, 'input', omissions, TOOL_FIELD_PREVIEW_BYTES);
  const metadata = boundStrings(state.metadata, 'metadata', omissions, TOOL_FIELD_PREVIEW_BYTES);
  if (omissions.count === 0) return part;
  return {
    ...part,
    state: {
      ...state,
      ...(state.output === undefined ? {} : { output }),
      ...(state.input === undefined ? {} : { input }),
      ...(state.metadata === undefined ? {} : { metadata }),
    },
    [TOOL_DETAIL_MARKER_FIELD]: marker(
      revision,
      omissions,
      patchSummary(part.tool, state.input, input)
    ),
  };
}

function projectKilo2ToolItem(item: Record<string, unknown>, revision: number) {
  if (item.type !== 'tool' || !isRecord(item.state) || item.state.status !== 'completed')
    return item;
  const state = item.state;
  const omissions: Omissions = { paths: [], count: 0, bytes: 0 };
  let content = state.content;
  if (Array.isArray(state.content)) {
    // The display output joins every text entry, so the entries share one budget.
    let remaining = TOOL_OUTPUT_PREVIEW_BYTES;
    let changed = false;
    content = state.content.map((entry: unknown, index) => {
      if (!isRecord(entry) || typeof entry.text !== 'string') return entry;
      const preview = utf8Preview(entry.text, remaining);
      if (preview === undefined) {
        remaining -= utf8Bytes(entry.text);
        return entry;
      }
      changed = true;
      remaining = 0;
      recordOmission(omissions, `content.${index}.text`, entry.text);
      return { ...entry, text: preview };
    });
    if (!changed) content = state.content;
  }
  const input = boundStrings(state.input, 'input', omissions, TOOL_FIELD_PREVIEW_BYTES);
  const metadata = boundStrings(state.metadata, 'metadata', omissions, TOOL_FIELD_PREVIEW_BYTES);
  if (omissions.count === 0) return item;
  return {
    ...item,
    state: {
      ...state,
      ...(state.content === undefined ? {} : { content }),
      ...(state.input === undefined ? {} : { input }),
      ...(state.metadata === undefined ? {} : { metadata }),
    },
    [TOOL_DETAIL_MARKER_FIELD]: marker(
      revision,
      omissions,
      patchSummary(item.name, state.input, input)
    ),
  };
}

/** Projects the completed tool entries of one native v2 message. */
export function projectKilo2MessageForDisplay(message: unknown, revision: number): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((item: unknown) => {
    if (!isRecord(item)) return item;
    const projected = projectKilo2ToolItem(item, revision);
    if (projected !== item) changed = true;
    return projected;
  });
  return changed ? { ...message, content } : message;
}

/** Projects a persisted or replayed `kilocode` event payload. */
export function projectKilocodeEventForDisplay(data: unknown, revision: number): unknown {
  if (!isRecord(data) || !isRecord(data.properties)) return data;
  const name = data.event ?? data.type;
  const properties = data.properties;
  if (name === 'message.part.updated') {
    const part = projectToolPartForDisplay(properties.part, revision);
    return part === properties.part ? data : { ...data, properties: { ...properties, part } };
  }
  if (name === 'conversation.message.updated') {
    const message = projectKilo2MessageForDisplay(properties.message, revision);
    return message === properties.message
      ? data
      : { ...data, properties: { ...properties, message } };
  }
  return data;
}
