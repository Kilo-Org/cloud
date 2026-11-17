/**
 * The parts of a cloud-agent error that every caller (web tRPC client, mobile
 * app, internal REST fetchers) needs, read from whichever shape it arrived in.
 *
 * `@trpc/client@11.19.0` builds `TRPCClientError` with `data = shape.data`, so a
 * real error carries both bags with the same values. Plain error-like objects
 * and REST responses do not, which is why both are read rather than one.
 *
 * Precedence is `data` first, then `shape.data`, then `shape`: `data` is the
 * documented tRPC error payload, `shape` is the raw transport error, and only
 * `shape` carries the numeric JSON-RPC code. A code is the tRPC semantic string
 * (`CONFLICT`), never that number, so numeric `code` values are ignored.
 */
export type CloudAgentErrorFields = {
  /** The tRPC error code the server sent, when it sent a string one. */
  code?: string;
  /** The HTTP status the server reported alongside the code. */
  httpStatus?: number;
  /**
   * True when the value carries the server's own error envelope in any of its
   * three forms: a string code, an HTTP status, or the numeric JSON-RPC code.
   * That means the request reached the server and this was its answer, which is
   * a different question from what code it carries.
   */
  answeredByServer: boolean;
};

type ErrorField = 'data' | 'shape' | 'code' | 'httpStatus';

/** One field of a value that may be any error shape; `unknown` when absent. */
function readField(source: unknown, key: ErrorField): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<ErrorField, unknown>)[key];
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function firstFiniteNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function readCloudAgentErrorFields(error: unknown): CloudAgentErrorFields {
  const data = readField(error, 'data');
  const shape = readField(error, 'shape');
  const shapeData = readField(shape, 'data');

  const dataCode = readField(data, 'code');
  const shapeDataCode = readField(shapeData, 'code');
  const shapeCode = readField(shape, 'code');
  const dataHttpStatus = readField(data, 'httpStatus');
  const shapeDataHttpStatus = readField(shapeData, 'httpStatus');

  const code = firstString([dataCode, shapeDataCode, shapeCode]);
  const httpStatus = firstFiniteNumber([dataHttpStatus, shapeDataHttpStatus]);

  // A JSON-RPC error envelope can carry only the numeric `shape.code` and no
  // `data` bag, so that number still proves the server answered even though it
  // is never returned as a code.
  const answeredByServer =
    typeof dataCode === 'string' ||
    typeof shapeDataCode === 'string' ||
    typeof shapeCode === 'string' ||
    typeof shapeCode === 'number' ||
    typeof dataHttpStatus === 'number' ||
    typeof shapeDataHttpStatus === 'number';

  const fields: CloudAgentErrorFields = { answeredByServer };
  if (code !== undefined) fields.code = code;
  if (httpStatus !== undefined) fields.httpStatus = httpStatus;
  return fields;
}
