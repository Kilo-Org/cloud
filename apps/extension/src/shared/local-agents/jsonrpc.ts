import { z } from 'zod';

/*
 * JSON-RPC 2.0 for protocol v1 (SPEC "Protocol v1"). Every frame the extension
 * exchanges with a CLI through the hub is one of these objects inside an
 * `{ type: "rpc", controllerId, message }` envelope. Requests are object-params
 * only: v1 defines no positional calls.
 */

export const LOCAL_AGENT_ERROR_CODES = {
  blocked: -32_011,
  browserUnavailable: -32_001,
  internalError: -32_603,
  invalidParams: -32_602,
  methodNotFound: -32_601,
  needsPermission: -32_010,
  originChanged: -32_012,
  protocolMismatch: -32_020,
  tabBusy: -32_002,
  tabTaken: -32_003,
  unsupportedInBrowser: -32_005,
  userStopped: -32_004,
} as const;

export type LocalAgentErrorCode =
  (typeof LOCAL_AGENT_ERROR_CODES)[keyof typeof LOCAL_AGENT_ERROR_CODES];

/** A JSON object, the only shape v1 params and results use. */
export type JsonRpcParams = Record<string, unknown>;
export type JsonRpcResult = Record<string, unknown>;

export class LocalAgentRpcError extends Error {
  readonly code: LocalAgentErrorCode;
  readonly data: unknown;

  constructor(code: LocalAgentErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'LocalAgentRpcError';
    this.code = code;
    this.data = data;
  }
}

export type JsonRpcOutcome =
  | { ok: true; result: JsonRpcResult }
  | { ok: false; code: number; message: string; data?: unknown };

export type JsonRpcMessage =
  | { kind: 'request'; id: string | number; method: string; params: JsonRpcParams }
  | { kind: 'notification'; method: string; params: JsonRpcParams }
  | { kind: 'response'; id: string | number; outcome: JsonRpcOutcome };

const jsonRpcIdSchema = z.union([z.string(), z.number()]);
const jsonRpcParamsSchema = z.record(z.string(), z.unknown());
const errorObjectSchema = z.object({
  code: z.number().int(),
  data: z.unknown().optional(),
  message: z.string(),
});
const requestSchema = z.object({
  id: jsonRpcIdSchema,
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: jsonRpcParamsSchema.optional(),
});
const notificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: jsonRpcParamsSchema.optional(),
});
const errorResponseSchema = z.object({
  error: errorObjectSchema,
  id: jsonRpcIdSchema,
  jsonrpc: z.literal('2.0'),
});
const resultResponseSchema = z.object({
  id: jsonRpcIdSchema,
  jsonrpc: z.literal('2.0'),
  result: z.unknown(),
});

const wireRecordSchema = z.record(z.string(), z.unknown());

/**
 * Decodes one wire message. The `in` checks are load-bearing: zod's
 * `z.unknown()` accepts a missing key, so a request would otherwise parse as a
 * successful response whose result is undefined.
 */
export const parseJsonRpcMessage = (value: unknown): JsonRpcMessage | null => {
  const wire = wireRecordSchema.safeParse(value);

  if (!wire.success) {
    return null;
  }

  const hasKey = (key: string): boolean => key in wire.data;
  const request = requestSchema.safeParse(wire.data);

  if (request.success) {
    return {
      id: request.data.id,
      kind: 'request',
      method: request.data.method,
      params: request.data.params ?? {},
    };
  }

  const notification = notificationSchema.safeParse(wire.data);

  if (notification.success) {
    return {
      kind: 'notification',
      method: notification.data.method,
      params: notification.data.params ?? {},
    };
  }

  if (hasKey('error')) {
    const errorResponse = errorResponseSchema.safeParse(wire.data);

    if (errorResponse.success) {
      return {
        id: errorResponse.data.id,
        kind: 'response',
        outcome: {
          code: errorResponse.data.error.code,
          ...(errorResponse.data.error.data === undefined
            ? {}
            : { data: errorResponse.data.error.data }),
          message: errorResponse.data.error.message,
          ok: false,
        },
      };
    }
  }

  if (hasKey('result')) {
    const resultResponse = resultResponseSchema.safeParse(wire.data);
    const result = resultResponse.success
      ? jsonRpcParamsSchema.safeParse(resultResponse.data.result)
      : null;

    if (resultResponse.success && result !== null && result.success) {
      return {
        id: resultResponse.data.id,
        kind: 'response',
        outcome: { ok: true, result: result.data },
      };
    }
  }

  return null;
};

export type JsonRpcWireMessage = Record<string, unknown>;

export const buildResultMessage = (id: string | number, result: JsonRpcResult) => ({
  id,
  jsonrpc: '2.0' as const,
  result,
});

export const buildErrorMessage = ({
  code,
  data,
  id,
  message,
}: {
  code: LocalAgentErrorCode;
  data?: unknown;
  id: string | number;
  message: string;
}) => ({
  error: { code, ...(data === undefined ? {} : { data }), message },
  id,
  jsonrpc: '2.0' as const,
});

export const buildNotification = (method: string, params: JsonRpcParams) => ({
  jsonrpc: '2.0' as const,
  method,
  params,
});
