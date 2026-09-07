import * as z from 'zod';
import { SESSION_ID_RE } from './protocol';

export const SandboxStatusSessionIdSchema = z
  .string()
  .regex(SESSION_ID_RE, 'Invalid session ID format')
  .startsWith('workspace_', 'Sandbox status requires a control-plane session');

export const SandboxLifecycleStatusSchema = z.enum([
  'active',
  'sleeping',
  'starting',
  'stopping',
  'error',
  'unreachable',
  'unknown',
]);

export type SandboxLifecycleStatus = z.infer<typeof SandboxLifecycleStatusSchema>;

export const SandboxProviderLabelSchema = z.enum(['Cloudflare', 'Vercel', 'Unknown']);

export type SandboxProviderLabel = z.infer<typeof SandboxProviderLabelSchema>;

export function getSandboxProviderLabel(provider: unknown): SandboxProviderLabel {
  switch (provider) {
    case 'cloudflare':
      return 'Cloudflare';
    case 'vercel':
      return 'Vercel';
    default:
      return 'Unknown';
  }
}

export const SandboxStatusDetailCodeSchema = z.enum([
  'sandbox_ready',
  'sandbox_stopped',
  'sandbox_starting',
  'sandbox_stopping',
  'sandbox_failed',
  'connection_unavailable',
  'status_unavailable',
  'insufficient_evidence',
]);

export type SandboxStatusDetailCode = z.infer<typeof SandboxStatusDetailCodeSchema>;

const STATUS_FOR_DETAIL_CODE = {
  sandbox_ready: 'active',
  sandbox_stopped: 'sleeping',
  sandbox_starting: 'starting',
  sandbox_stopping: 'stopping',
  sandbox_failed: 'error',
  connection_unavailable: 'unreachable',
  status_unavailable: 'unknown',
  insufficient_evidence: 'unknown',
} as const satisfies Record<SandboxStatusDetailCode, SandboxLifecycleStatus>;

export const SANDBOX_STATUS_DETAIL_MESSAGES = {
  sandbox_ready: 'The sandbox is active.',
  sandbox_stopped: 'The sandbox is sleeping. Send a message to resume.',
  sandbox_starting: 'The sandbox is starting.',
  sandbox_stopping: 'The sandbox is stopping.',
  sandbox_failed: 'The sandbox encountered an error. Send a message to try again.',
  connection_unavailable:
    'The sandbox connection is unavailable. Its current state cannot be confirmed.',
  status_unavailable:
    'Sandbox status is temporarily unavailable. This does not mean the sandbox failed.',
  insufficient_evidence: "There is not enough information to confirm the sandbox's current state.",
} as const satisfies Record<SandboxStatusDetailCode, string>;

const timestampSchema = z.number().finite().int().nonnegative().max(8_640_000_000_000_000);

export const SandboxRuntimeVersionSchema = z
  .string()
  .max(64)
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc|canary|dev)(?:[.-]\d{1,14})?)?(?![\s\S])/);

export function safeSandboxRuntimeVersion(value: unknown): string | null {
  const parsed = SandboxRuntimeVersionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const SandboxRuntimeMetadataSchema = z.object({
  sandboxType: z
    .enum([
      'shared',
      'isolated-small',
      'isolated-standard',
      'code-review',
      'devcontainer',
      'unknown',
    ])
    .nullable(),
  kiloCliVersion: SandboxRuntimeVersionSchema.nullable(),
  wrapperVersion: SandboxRuntimeVersionSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  stoppedAt: timestampSchema.nullable(),
});

export type SandboxRuntimeMetadata = z.infer<typeof SandboxRuntimeMetadataSchema>;

export const SandboxStatusSnapshotSchema = z
  .object({
    status: SandboxLifecycleStatusSchema,
    provider: SandboxProviderLabelSchema,
    observedAt: timestampSchema.describe(
      'Snapshot creation time in Unix epoch milliseconds, not a fresh sandbox probe'
    ),
    detailCode: SandboxStatusDetailCodeSchema,
    runtime: SandboxRuntimeMetadataSchema.optional(),
    inactivityTimeoutMs: z
      .number()
      .finite()
      .int()
      .positive()
      .nullable()
      .describe('Applicable inactivity timeout in milliseconds, or null when unknown'),
    estimatedSleepAt: timestampSchema
      .nullable()
      .describe(
        'Approximate sleep time supported by authoritative sandbox-wide idle evidence, in Unix epoch milliseconds'
      ),
  })
  .refine(snapshot => STATUS_FOR_DETAIL_CODE[snapshot.detailCode] === snapshot.status, {
    message: 'Sandbox status and detail code must agree',
    path: ['detailCode'],
  })
  .refine(
    snapshot =>
      snapshot.estimatedSleepAt === null ||
      (snapshot.status === 'active' &&
        snapshot.inactivityTimeoutMs !== null &&
        snapshot.estimatedSleepAt > snapshot.observedAt),
    {
      message: 'Sleep estimates require an active sandbox, a known timeout, and a future timestamp',
      path: ['estimatedSleepAt'],
    }
  );

export type SandboxStatusSnapshot = z.infer<typeof SandboxStatusSnapshotSchema>;
