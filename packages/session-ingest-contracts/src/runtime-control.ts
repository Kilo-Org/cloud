import { z } from 'zod';

import { sessionIdSchema } from './rpc-contract';

/**
 * Audience for the five-minute, audience-bound internal JWT that authenticates
 * the web app's Local Runtime Control module against the session-ingest
 * internal routes. The matching `verifyKiloToken` call in the session-ingest
 * middleware requires this exact audience.
 */
export const SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE = 'session-ingest:runtime-control';

/**
 * Capabilities a local runtime can advertise. The set is intentionally small
 * and bounded — each value maps to a specific relay command the server module
 * may route. The relay rejects unknown capabilities on the wire.
 */
export const localRuntimeCapabilitySchema = z.enum(['catalog.v1', 'create-and-run.v1']);
export type LocalRuntimeCapability = z.infer<typeof localRuntimeCapabilitySchema>;

/**
 * The exact fence the server module uses when routing a control command to a
 * specific runtime. `runtimeId` identifies the `kilo remote` process; it
 * survives that process's WebSocket reconnects but changes on process restart.
 * `connectionId` is opaque relay routing metadata owned by the session-ingest DO.
 */
export const localRuntimeFenceSchema = z
  .object({
    runtimeId: z.string().uuid(),
    connectionId: z.string().min(1).max(128),
  })
  .strict();
export type LocalRuntimeFence = z.infer<typeof localRuntimeFenceSchema>;

/**
 * Safe metadata the CLI advertises for a live runtime. The absolute launch
 * directory is never included — only the basename is exposed as `projectName`,
 * and labels are length-limited and sanitized at the CLI boundary.
 */
export const localRuntimePresenceSchema = localRuntimeFenceSchema
  .extend({
    protocolVersion: z.literal(1),
    cliVersion: z.string().min(1).max(32),
    displayName: z.string().min(1).max(80),
    projectName: z.string().min(1).max(80),
    capabilities: z
      .array(localRuntimeCapabilitySchema)
      .max(2)
      .refine(values => new Set(values).size === values.length, {
        message: 'runtime capabilities must be unique',
      }),
  })
  .strict();
export type LocalRuntimePresence = z.infer<typeof localRuntimePresenceSchema>;

/**
 * Bounded agent entry the CLI exposes inside a runtime catalog. The full
 * catalog model schema is parsed by the web client, not the cross-service
 * contract, so the model payload is `unknown` here.
 */
export const localRuntimeAgentSchema = z
  .object({
    slug: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    model: z
      .object({
        providerID: z.string().min(1).max(255),
        modelID: z.string().min(1).max(255),
      })
      .strict()
      .optional(),
    variant: z.string().min(1).max(100).optional(),
  })
  .strict();
export type LocalRuntimeAgent = z.infer<typeof localRuntimeAgentSchema>;

export const localRuntimeCatalogSchema = z
  .object({
    protocolVersion: z.literal(1),
    models: z.unknown(),
    agents: z.array(localRuntimeAgentSchema).max(128),
    defaultAgent: z.string().min(1).max(100),
  })
  .strict();
export type LocalRuntimeCatalog = z.infer<typeof localRuntimeCatalogSchema>;

export const getLocalRuntimeCatalogRequestSchema = z
  .object({ protocolVersion: z.literal(1) })
  .strict();
export type GetLocalRuntimeCatalogRequest = z.infer<typeof getLocalRuntimeCatalogRequestSchema>;

/**
 * Stable error codes the server module surfaces to mobile. Mobile branches on
 * `code` to choose the recovery flow. Each code has a dedicated recovery
 * behavior — do not reuse codes for semantically different failures.
 */
export const localRuntimeControlErrorCodeSchema = z.enum([
  'RUNTIME_NOT_CONNECTED',
  'RUNTIME_FENCE_MISMATCH',
  'CLI_UPGRADE_REQUIRED',
  'CATALOG_CHANGED',
  'COMMAND_ALREADY_PENDING',
  'PENDING_COMMAND_LIMIT',
  'COMMAND_EXPIRED',
  'RESULT_TOO_LARGE',
  'INVALID_RUNTIME_RESPONSE',
  'RUNTIME_COMMAND_FAILED',
  'COMMAND_NOT_ALLOWED',
]);
export type LocalRuntimeControlErrorCode = z.infer<typeof localRuntimeControlErrorCodeSchema>;

export const localRuntimeControlErrorSchema = z
  .object({
    source: z.literal('relay'),
    code: localRuntimeControlErrorCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();
export type LocalRuntimeControlError = z.infer<typeof localRuntimeControlErrorSchema>;

export type LocalRuntimeCommandOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: LocalRuntimeControlError };

/**
 * Create-and-run request payload. The full result schema lives in the
 * runtime-control module; this contract only carries the relay-facing
 * discriminator. Out of scope for the runtime-presence slice.
 */
export const createAndRunLocalSessionRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(32_768),
    model: z
      .object({
        providerID: z.string().min(1).max(255),
        modelID: z.string().min(1).max(255),
      })
      .strict(),
    variant: z.string().min(1).max(100).optional(),
    agent: z.string().min(1).max(100),
  })
  .strict();
export type CreateAndRunLocalSessionRequest = z.infer<typeof createAndRunLocalSessionRequestSchema>;

export const createAndRunLocalSessionResultSchema = z.discriminatedUnion('promptStarted', [
  z
    .object({
      protocolVersion: z.literal(1),
      sessionId: sessionIdSchema,
      promptStarted: z.literal(true),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      sessionId: sessionIdSchema,
      promptStarted: z.literal(false),
      error: z
        .object({
          code: z.literal('PROMPT_START_FAILED'),
          message: z.literal('The session was created, but the first prompt did not start.'),
        })
        .strict(),
    })
    .strict(),
]);
export type CreateAndRunLocalSessionResult = z.infer<typeof createAndRunLocalSessionResultSchema>;

/**
 * Server-side envelope for the `localRuntimeControl.createAndRun` mutation.
 *
 * The relay completes the runtime command and returns a CLI result; the
 * server then waits for the announced session row to become fetchable
 * through `cli_sessions_v2` so the mobile client can navigate directly to
 * the existing session detail route. The envelope is a discriminated union
 * so callers never have to infer which path the server took.
 *
 * - `ready`: the row is owned by the requesting user. The CLI result is
 *   returned exactly as the relay produced it.
 * - `session_not_ready`: the server exhausted its bounded wait without
 *   observing an owned row. The CLI result is still returned so mobile can
 *   open the existing session (for `promptStarted:false`) or poll the
 *   separate `cliSessionsV2.readiness` query for recovery. The server NEVER
 *   issues a second relay create command.
 */
export const localRuntimeCreateOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      result: createAndRunLocalSessionResultSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('session_not_ready'),
      code: z.literal('SESSION_NOT_READY'),
      result: createAndRunLocalSessionResultSchema,
    })
    .strict(),
]);
export type LocalRuntimeCreateOutput = z.infer<typeof localRuntimeCreateOutputSchema>;

/**
 * Response envelope for the list endpoint. The list is capped at 32 runtimes
 * to keep the payload bounded; the DO enforces the same cap internally.
 */
export const localRuntimeListResponseSchema = z
  .object({ runtimes: z.array(localRuntimePresenceSchema).max(32) })
  .strict();
export type LocalRuntimeListResponse = z.infer<typeof localRuntimeListResponseSchema>;

export const localRuntimeCatalogResponseSchema = z
  .object({ catalog: localRuntimeCatalogSchema })
  .strict();

export const localRuntimeCreateResponseSchema = z
  .object({ result: createAndRunLocalSessionResultSchema })
  .strict();

export const localRuntimeErrorResponseSchema = z
  .object({ error: localRuntimeControlErrorSchema })
  .strict();
