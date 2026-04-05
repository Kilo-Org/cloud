import type { StreamEventType } from './protocol.js';

export const MAX_TOOL_OUTPUT_LENGTH = 10_000;
export const MAX_RAW_INPUT_LENGTH = 10_000;
export const MAX_STDOUT_LENGTH = 10_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n[…truncated]';
}

function stripFilePartFields(part: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...part, url: '' };
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

function trimPartUpdated(properties: Record<string, unknown>): Record<string, unknown> {
  const part = properties.part;
  if (!isRecord(part)) return properties;

  const partType = part.type;

  if (partType === 'step-start' || partType === 'step-finish' || partType === 'snapshot') {
    return { ...properties, part: { ...part, snapshot: undefined } };
  }

  if (partType === 'file') {
    return { ...properties, part: stripFilePartFields(part) };
  }

  if (partType === 'tool') {
    const state = part.state;
    if (!isRecord(state)) return properties;

    if (state.status === 'completed') {
      return { ...properties, part: { ...part, state: trimToolCompleted(state) } };
    }
    if (state.status === 'pending') {
      return { ...properties, part: { ...part, state: trimToolPending(state) } };
    }
  }

  return properties;
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
    if (!isRecord(properties)) return data;
    return { ...data, properties: trimPartUpdated(properties) };
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

export function trimPayload(streamEventType: StreamEventType, data: unknown): unknown {
  if (!isRecord(data)) return data;

  if (streamEventType === 'kilocode') {
    return trimKilocodeData(data);
  }

  if (streamEventType === 'output') {
    return trimOutputData(data);
  }

  return data;
}
