import { z, type ZodType } from 'zod';

export type GatewayProcessStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'shutting_down';
  pid: number | null;
  uptime: number;
  restarts: number;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
};

export const GatewayProcessStatusSchema: ZodType<GatewayProcessStatus> = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'shutting_down']),
  pid: z.number().int().nullable(),
  uptime: z.number(),
  restarts: z.number().int(),
  lastExit: z
    .object({
      code: z.number().int().nullable(),
      signal: z
        .custom<NodeJS.Signals>((value): value is NodeJS.Signals => typeof value === 'string')
        .nullable(),
      at: z.string(),
    })
    .nullable(),
});

export const GatewayCommandResponseSchema = z.object({
  ok: z.boolean(),
});

export const ConfigRestoreResponseSchema = z.object({
  ok: z.boolean(),
  signaled: z.boolean(),
});

export const ControllerVersionResponseSchema = z.object({
  version: z.string(),
  commit: z.string(),
  // optional() for backward compat with older controllers that don't include these fields
  openclawVersion: z.string().nullable().optional(),
  openclawCommit: z.string().nullable().optional(),
});

export class GatewayControllerError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'GatewayControllerError';
    this.status = status;
    this.code = code ?? null;
  }
}

// Treat the Openclaw config on disk as an opaque blob
export const OpenclawConfigResponseSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  etag: z.string(),
});

// ──────────────────────────────────────────────────────────────────────
// Controller pairing responses
// ──────────────────────────────────────────────────────────────────────

export const ControllerChannelPairingResponseSchema = z.object({
  requests: z.array(
    z.object({
      code: z.string(),
      id: z.string(),
      channel: z.string(),
      meta: z.unknown().optional(),
      createdAt: z.string().optional(),
    })
  ),
  lastUpdated: z.string(),
});

export const ControllerDevicePairingResponseSchema = z.object({
  requests: z.array(
    z.object({
      requestId: z.string(),
      deviceId: z.string(),
      role: z.string().optional(),
      platform: z.string().optional(),
      clientId: z.string().optional(),
      ts: z.number().optional(),
    })
  ),
  lastUpdated: z.string(),
});

export const ControllerPairingApproveResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
