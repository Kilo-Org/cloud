export type TrimPayloadStreamEventType = string;

export const MAX_TOOL_OUTPUT_LENGTH = 10_000;
export const MAX_RAW_INPUT_LENGTH = 10_000;
export const MAX_STDOUT_LENGTH = 10_000;

/**
 * Inline `data:` URLs up to this length are preserved on top-level file parts
 * so the mobile client can render small inlined images live. Half the 1 MiB
 * ingest-frame budget (`MAX_INGEST_EVENT_BYTES` in `ingest-frame.ts`), so a
 * single inline file part never alone exceeds it. Larger `data:` URLs are
 * stripped for size.
 */
export const MAX_INLINE_FILE_URL_LENGTH = 512 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n[…truncated]';
}

function stripFilePartFields(
  part: Record<string, unknown>,
  options?: { preserveSmallDataUrls?: boolean }
): Record<string, unknown> {
  // Preserve small, non-`data:` URLs (`file://` sandbox paths, `http(s)`) and,
  // on top-level file parts, small inline `data:` URLs. The mobile client
  // captures the cloud-agent attachment reference from the raw `file://` URL
  // before the SDK strip, and renders small inline `data:` images directly;
  // the live stream must keep both. Large `data:` URLs carry inline base64
  // bytes and are stripped for size.
  const url = part.url;
  const stripDataUrl =
    typeof url === 'string' &&
    url.startsWith('data:') &&
    (!options?.preserveSmallDataUrls || url.length > MAX_INLINE_FILE_URL_LENGTH);
  const out: Record<string, unknown> = {
    ...part,
    ...(stripDataUrl ? { url: '' } : {}),
  };
  const source = part.source;
  if (isRecord(source)) {
    const text = source.text;
    if (isRecord(text)) {
      out.source = { ...source, text: { ...text, value: '' } };
    }
  }
  return out;
}

function trimToolCompleted(state: Record<string, unknown>): Record<string, unknown> {
  const out = { ...state };
  const output = out.output;
  if (typeof output === 'string') {
    out.output = truncate(output, MAX_TOOL_OUTPUT_LENGTH);
  }
  const attachments = out.attachments;
  if (Array.isArray(attachments)) {
    out.attachments = attachments.map((a: unknown) => (isRecord(a) ? stripFilePartFields(a) : a));
  }
  return out;
}

function trimToolPending(state: Record<string, unknown>): Record<string, unknown> {
  const out = { ...state };
  const raw = out.raw;
  if (typeof raw === 'string') {
    out.raw = truncate(raw, MAX_RAW_INPUT_LENGTH);
  }
  return out;
}

function trimPart(part: Record<string, unknown>): Record<string, unknown> {
  const partType = part.type;

  if (partType === 'step-start' || partType === 'step-finish' || partType === 'snapshot') {
    return { ...part, snapshot: undefined };
  }

  if (partType === 'file') {
    return stripFilePartFields(part, { preserveSmallDataUrls: true });
  }

  if (partType === 'tool') {
    const state = part.state;
    if (!isRecord(state)) return part;

    if (state.status === 'completed') {
      return { ...part, state: trimToolCompleted(state) };
    }
    if (state.status === 'pending') {
      return { ...part, state: trimToolPending(state) };
    }
  }

  return part;
}

function trimPartUpdated(properties: Record<string, unknown>): Record<string, unknown> {
  const part = properties.part;
  if (!isRecord(part)) return properties;
  return { ...properties, part: trimPart(part) };
}

function trimSessionUpdated(properties: Record<string, unknown>): Record<string, unknown> {
  const info = properties.info;
  if (!isRecord(info)) return properties;

  const summary = info.summary;
  if (!isRecord(summary)) return properties;

  return {
    ...properties,
    info: {
      ...info,
      summary: { ...summary, diffs: undefined },
    },
  };
}

function trimKilocodeData(data: Record<string, unknown>): Record<string, unknown> {
  const eventName = data.event ?? data.type;

  if (eventName === 'message.part.updated') {
    const properties = data.properties;
    const part = data.part;
    const trimmedData = isRecord(part) ? { ...data, part: trimPart(part) } : data;
    if (!isRecord(properties)) return trimmedData;
    return { ...trimmedData, properties: trimPartUpdated(properties) };
  }

  if (eventName === 'session.updated') {
    const properties = data.properties;
    if (!isRecord(properties)) return data;
    return { ...data, properties: trimSessionUpdated(properties) };
  }

  return data;
}

function trimOutputData(data: Record<string, unknown>): Record<string, unknown> {
  const content = data.content;
  if (typeof content !== 'string') return data;
  return { ...data, content: truncate(content, MAX_STDOUT_LENGTH) };
}

export function trimPayload(streamEventType: TrimPayloadStreamEventType, data: unknown): unknown {
  if (!isRecord(data)) return data;

  if (streamEventType === 'kilocode') {
    return trimKilocodeData(data);
  }

  if (streamEventType === 'output') {
    return trimOutputData(data);
  }

  return data;
}
