import { z } from 'zod';

export const AgentStartupPhase = z.enum(['initial_prompt']);
export type AgentStartupPhase = z.infer<typeof AgentStartupPhase>;

export type AgentStartupErrorPayload = {
  error: string;
  phase?: AgentStartupPhase;
  status?: number;
  error_type?: string;
  action?: string;
};

const StringRecord = z.record(z.string(), z.unknown());
const GatewayErrorBody = z
  .object({
    error: z.unknown().optional(),
    error_type: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
const ErrorObject = z
  .object({
    message: z.string().optional(),
    status: z.number().optional(),
    statusCode: z.number().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    body: z.unknown().optional(),
    data: z.unknown().optional(),
    response: z
      .object({
        status: z.number().optional(),
        statusCode: z.number().optional(),
        body: z.unknown().optional(),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export class AgentStartupError extends Error {
  readonly payload: AgentStartupErrorPayload;

  constructor(payload: AgentStartupErrorPayload) {
    super(payload.error);
    this.name = 'AgentStartupError';
    this.payload = payload;
  }
}

type JsonParseResult = { success: true; data: unknown } | { success: false };

function parseJsonFromString(value: string): JsonParseResult {
  const trimmed = value.trim();
  if (!trimmed) return { success: false };

  try {
    return { success: true, data: JSON.parse(trimmed) };
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return { success: false };
    try {
      return { success: true, data: JSON.parse(trimmed.slice(start, end + 1)) };
    } catch {
      return { success: false };
    }
  }
}

function readGatewayBody(value: unknown): z.infer<typeof GatewayErrorBody> | null {
  if (typeof value === 'string') {
    const parsed = parseJsonFromString(value);
    if (!parsed.success) return null;
    return readGatewayBody(parsed.data);
  }

  const parsed = GatewayErrorBody.safeParse(value);
  if (!parsed.success) return null;
  if (
    parsed.data.error === undefined &&
    parsed.data.error_type === undefined &&
    parsed.data.message === undefined
  ) {
    return null;
  }
  return parsed.data;
}

function readBodyMessage(errorValue: unknown): string | undefined {
  if (typeof errorValue === 'string') return errorValue;

  const record = StringRecord.safeParse(errorValue);
  if (!record.success) return undefined;

  const message = record.data.message;
  if (typeof message === 'string') return message;

  const code = record.data.code;
  if (typeof code === 'string') return code;

  return undefined;
}

function gatewayBodyFromError(err: unknown): z.infer<typeof GatewayErrorBody> | null {
  if (err instanceof Error) {
    const fromMessage = readGatewayBody(err.message);
    if (fromMessage) return fromMessage;
  }

  const direct = readGatewayBody(err);
  if (direct) return direct;

  const parsed = ErrorObject.safeParse(err);
  if (!parsed.success) return null;

  return (
    readGatewayBody(parsed.data.body) ??
    readGatewayBody(parsed.data.data) ??
    readGatewayBody(parsed.data.response?.body) ??
    readGatewayBody(parsed.data.response?.data) ??
    (parsed.data.message ? readGatewayBody(parsed.data.message) : null)
  );
}

function statusFromError(err: unknown): number | undefined {
  const parsed = ErrorObject.safeParse(err);
  if (!parsed.success) return undefined;

  const status =
    parsed.data.status ??
    parsed.data.statusCode ??
    parsed.data.response?.status ??
    parsed.data.response?.statusCode;
  if (status) return status;

  const code = parsed.data.code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}

function messageFromError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Agent startup failed';
}

export function classifyStartupError(
  err: unknown,
  phase?: AgentStartupPhase
): AgentStartupErrorPayload {
  if (err instanceof AgentStartupError) return err.payload;

  const body = gatewayBodyFromError(err);
  const status = statusFromError(err);
  const errorType = body?.error_type;
  const gatewayMessage = readBodyMessage(body?.error) ?? body?.message;

  if (phase === 'initial_prompt' && status === 429 && errorType === 'rate_limit_exceeded') {
    return {
      error:
        gatewayMessage ??
        'Kilo gateway rejected the initial prompt because the selected model is rate limited.',
      phase,
      status,
      error_type: errorType,
      action: 'Wait and retry, or switch the town/rig to a model with available quota.',
    };
  }

  return {
    error: gatewayMessage ?? messageFromError(err),
    ...(phase ? { phase } : {}),
    ...(status ? { status } : {}),
    ...(errorType ? { error_type: errorType } : {}),
  };
}
