import { createHash } from 'node:crypto';

// Compares a probe request against a request the CLI really sent. Two things differ by
// construction: the CLI's per-run call ids, and the `Continue.` turn with its environment
// block that a fresh CLI session needs to send at all (the probe ends on the tool result).
// Long strings are hashed so the stored pilot fixture stays reviewable; both sides are
// hashed the same way, so a content change still fails.
//
// The call ids are normalised on every record that carries one: chat `tool_calls` and tool
// messages, Responses `function_call`/`function_call_output`, and Messages `tool_use`/
// `tool_result` blocks.

const LONG_STRING = 200;
const HEAD = 160;
const CALL_ID_KEYS: Record<string, true> = {
  call_id: true,
  tool_call_id: true,
  tool_use_id: true,
  id: true,
};

function isHarnessPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null || !('text' in part)) return false;
  const { text } = part;
  return (
    typeof text === 'string' &&
    (text.includes('<environment_details>') || text.trim() === 'Continue.')
  );
}

function withoutHarnessTurn(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutHarnessTurn);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? (record.content as unknown[]).filter(part => !isHarnessPart(part))
    : record.content;
  if (record.role === 'user' && Array.isArray(content) && content.length === 0) return null;
  if (record.role === 'user' && typeof content === 'string' && isHarnessPart({ text: content })) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      key === 'content'
        ? Array.isArray(content)
          ? withoutHarnessTurn(content)
          : content
        : withoutHarnessTurn(entry),
    ])
  );
}

function trimmed(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= LONG_STRING
      ? value
      : `${value.slice(0, HEAD)}…${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
  }
  if (Array.isArray(value)) return value.map(trimmed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimmed(entry)]));
  }
  return value;
}

function withCallIds(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map(entry => withCallIds(entry, ids));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const isToolCall =
    record.type === 'function_call' ||
    record.type === 'function_call_output' ||
    record.type === 'function' ||
    record.type === 'tool_use' ||
    record.type === 'tool_result' ||
    record.role === 'tool' ||
    Array.isArray(record.tool_calls);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (isToolCall && CALL_ID_KEYS[key] === true && typeof entry === 'string') {
        const known = ids.get(entry) ?? `call_${ids.size}`;
        ids.set(entry, known);
        return [key, known];
      }
      return [key, withCallIds(entry, ids)];
    })
  );
}

// The SDK serializes optional fields as explicit nulls; absent and null are the same body.
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, withoutNulls(entry)])
  );
}

function withoutHarnessMessages(body: Record<string, unknown>): Record<string, unknown> {
  const key = Array.isArray(body.messages)
    ? 'messages'
    : Array.isArray(body.input)
      ? 'input'
      : null;
  if (key === null) return body;
  const items = (body[key] as unknown[]).map(withoutHarnessTurn).filter(item => item !== null);
  return { ...body, [key]: items };
}

export function comparableBody(body: Record<string, unknown>): unknown {
  return withoutNulls(trimmed(withCallIds(withoutHarnessMessages(body), new Map())));
}
