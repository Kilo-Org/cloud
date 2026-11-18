import { z } from 'zod';

const targetSettingsSchema = z.object({
  sandboxAllocation: z.string().nullable(),
  egressMode: z.enum(['unrestricted', 'allowlist']).nullable(),
  egressAllowlist: z.array(z.string()).nullable(),
  egressRequiredHosts: z.array(z.string()).nullable(),
});

const secretRequestSchema = z.object({
  key: z.string(),
  reason: z.string(),
  references: z.array(
    z.object({
      repoFullName: z.string(),
      path: z.string(),
      line: z.number().int(),
      verified: z.boolean().optional(),
    })
  ),
  highPrivilege: z.boolean(),
  state: z.enum(['pending', 'provided', 'skipped']),
  requestedAt: z.string(),
});

const networkRequestSchema = z.object({
  host: z.string(),
  reason: z.string(),
  evidence: z.union([
    z.object({ sessionId: z.string(), requestCount: z.number().int() }),
    z.object({ childSessionId: z.string(), deniedCount: z.number().int() }),
  ]),
  state: z.enum(['pending', 'approved', 'declined']),
  requestedAt: z.string(),
});

const checkSchema = z.object({ name: z.string(), command: z.string(), expect: z.string() });

const pendingVerificationSchema = z.object({
  operationKey: z.string(),
  childSessionId: z.string().nullable(),
  childKiloSessionId: z.string().nullable(),
  configurationRevision: z.number().int(),
  checks: z.array(checkSchema),
  startedAt: z.string(),
  sandboxAllocation: z.string().nullable(),
  egressAllowlist: z.array(z.string()).nullable(),
});

const verificationSchema = z.object({
  childSessionId: z.string(),
  childKiloSessionId: z.string().nullable(),
  configurationRevision: z.number().int().nullable(),
  preparation: z.enum(['completed', 'failed', 'running', 'missing']),
  preparationError: z.string().nullable(),
  setupDurationMs: z.number().nullable(),
  egressMode: z.enum(['unrestricted', 'allowlist']).nullable(),
  sandboxAllocation: z.string().nullable().optional(),
  egressAllowlist: z.array(z.string()).nullable().optional(),
  checks: z.array(checkSchema),
  results: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string() })),
  recordedAt: z.string(),
});

const previousConfigurationSchema = z.object({
  environmentId: z.string(),
  revision: z.number().int(),
  commands: z.array(z.string()),
  repositories: z.unknown(),
  sandboxAllocation: z.string().nullable(),
  egressMode: z.string().nullable(),
  egressAllowlist: z.array(z.string()).nullable(),
  egressRequiredHosts: z.array(z.string()).nullable(),
  vars: z.array(z.object({ key: z.string(), value: z.string(), isSecret: z.boolean() })),
});

export const environmentSetupRunDataSchema = z.object({
  requirements: z.string(),
  model: z.string(),
  variant: z.string().nullable().default(null),
  launch_repo_full_name: z.string(),
  sandbox_options: z.array(z.string()).default([]),
  kilo_session_id: z.string().nullable().default(null),
  target_revision_at_fork: z.number().int().nullable().default(null),
  target_settings_at_fork: targetSettingsSchema.nullable().default(null),
  status_reason: z.string().nullable().default(null),
  status_detail: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  secret_requests: z.array(secretRequestSchema).default([]),
  network_requests: z.array(networkRequestSchema).default([]),
  generated_secret_keys: z.array(z.string()).default([]),
  pending_verification: pendingVerificationSchema.nullable().default(null),
  last_verification: verificationSchema.nullable().default(null),
  previous_configuration: previousConfigurationSchema.nullable().default(null),
  published_revision: z.number().int().nullable().default(null),
  published_settings: targetSettingsSchema.nullable().default(null),
});

export type EnvironmentSetupRunData = z.infer<typeof environmentSetupRunDataSchema>;
export type EnvironmentSetupTargetSettings = z.infer<typeof targetSettingsSchema>;
export type EnvironmentSetupSecretRequest = z.infer<typeof secretRequestSchema>;
export type EnvironmentSetupNetworkRequest = z.infer<typeof networkRequestSchema>;
export type EnvironmentSetupCheck = z.infer<typeof checkSchema>;
export type EnvironmentSetupPendingVerification = z.infer<typeof pendingVerificationSchema>;
export type EnvironmentSetupVerification = z.infer<typeof verificationSchema>;
export type EnvironmentSetupPreviousConfiguration = z.infer<typeof previousConfigurationSchema>;
