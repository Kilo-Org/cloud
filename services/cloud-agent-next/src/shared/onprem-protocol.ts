import { z } from 'zod';

export const ON_PREM_PROTOCOL_VERSION = 1;
export const ON_PREM_MAX_BATCH_SIZE = 32;
export const ON_PREM_CLOCK_SKEW_MS = 5_000;
export const ON_PREM_MAX_LIFETIME_MS = 86_400_000;
export const ON_PREM_ALLOCATION_REPLAY_WINDOW_MS = 24 * 60 * 60_000;

const uuidSchema = z.uuid().toLowerCase();
export const onPremOrganizationIdSchema = uuidSchema;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const integerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoDateSchema = z.iso.datetime({ offset: true }).max(64);
const installationNameSchema = z.string().min(1).max(128).regex(/\S/);
const runnerVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);
const diagnosticCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
const dnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const dnsSubdomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/);
const providerRefIdentitySchema = z
  .object({ installationId: uuidSchema, allocationId: uuidSchema })
  .strict();

export type OnPremProviderRef = z.infer<typeof providerRefIdentitySchema>;

export function encodeOnPremProviderRef(ref: OnPremProviderRef): string {
  const { installationId, allocationId } = providerRefIdentitySchema.parse(ref);
  return `onprem:v1:${installationId}:${allocationId}`;
}

export function decodeOnPremProviderRef(raw: unknown): OnPremProviderRef | null {
  if (typeof raw !== 'string' || raw.length > 128) return null;
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'onprem' || parts[1] !== 'v1') return null;
  const parsed = providerRefIdentitySchema.safeParse({
    installationId: parts[2],
    allocationId: parts[3],
  });
  return parsed.success ? parsed.data : null;
}

export const onPremProviderBindingSchema = z
  .object({
    kind: z.literal('onprem'),
    organizationId: onPremOrganizationIdSchema,
    installationId: uuidSchema,
    profileId: identifierSchema,
  })
  .strict();

export const onPremProfileSchema = z
  .object({
    id: identifierSchema,
    revision: identifierSchema,
    runtimeClass: dnsSubdomainSchema,
    image: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/),
    brokerUrl: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .regex(
        /^https:\/\/[^\s/?#@\\]+\/?$/i,
        'Broker URL must be an HTTPS origin without credentials, a path, a query, or a fragment'
      ),
    maxLifetimeMs: z.number().int().min(600_000).max(ON_PREM_MAX_LIFETIME_MS),
  })
  .strict();

export const onPremInstanceResourcesSchema = z
  .object({
    cpuMillis: z.number().int().min(100).max(8000),
    memoryMiB: z.number().int().min(256).max(16384),
    diskMiB: z.number().int().min(512).max(32768),
  })
  .strict();

export const onPremInstanceTypeSchema = z
  .object({
    id: dnsLabelSchema,
    displayName: z.string().trim().min(1).max(100),
    resources: onPremInstanceResourcesSchema,
  })
  .strict();

export const onPremInstanceTypesSchema = z
  .array(onPremInstanceTypeSchema)
  .max(32)
  .refine(
    instanceTypes =>
      new Set(instanceTypes.map(instanceType => instanceType.id)).size === instanceTypes.length,
    'Instance type IDs must be unique'
  );

export const onPremInstallationStatusSchema = z
  .object({
    id: uuidSchema,
    organizationId: onPremOrganizationIdSchema,
    name: installationNameSchema,
    state: z.enum(['pending', 'ready', 'offline', 'failed', 'revoked']),
    enrolledAt: isoDateSchema.nullable(),
    lastSeenAt: isoDateSchema.nullable(),
    runnerVersion: runnerVersionSchema.nullable(),
    profile: onPremProfileSchema.nullable(),
    instanceTypes: onPremInstanceTypesSchema.default([]),
    diagnosticCode: diagnosticCodeSchema.nullable(),
    activeAllocations: integerSchema,
    cleanupPending: z.boolean(),
  })
  .strict();

export const onPremStatusSchema = z
  .object({ selected: z.boolean(), installation: onPremInstallationStatusSchema.nullable() })
  .strict();

export const onPremEnrollmentRequestSchema = z.object({ name: installationNameSchema }).strict();

export const onPremEnrollmentResponseSchema = z
  .object({
    installationId: uuidSchema,
    organizationId: onPremOrganizationIdSchema,
    bootstrapToken: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
    expiresAt: isoDateSchema,
    protocolVersion: z.literal(ON_PREM_PROTOCOL_VERSION),
  })
  .strict();

export const onPremSelectRequestSchema = z
  .object({
    installationId: uuidSchema,
    profileId: identifierSchema,
    selected: z.boolean(),
  })
  .strict();

export const onPremRevokeRequestSchema = z.object({ installationId: uuidSchema }).strict();

export const onPremEnrollRequestSchema = z
  .object({
    protocolVersion: z.literal(ON_PREM_PROTOCOL_VERSION),
    credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
    runnerVersion: runnerVersionSchema,
    profile: onPremProfileSchema,
  })
  .strict();

export const onPremEnrollResponseSchema = z
  .object({
    protocolVersion: z.literal(ON_PREM_PROTOCOL_VERSION),
    installationId: uuidSchema,
  })
  .strict();

const bootstrapKeys: ReadonlySet<string> = new Set([
  'SANDBOX_CONTROL_URL',
  'SANDBOX_CONTROL_CREDENTIAL',
  'PROVIDER_INSTANCE_ID',
  'KILO_PLATFORM',
  'KILO_DISABLE_AUTOUPDATE',
  'KILO_DEBUG_SESSION_INGEST',
]);
const bootstrapSchema = z.record(
  z.string().refine(key => bootstrapKeys.has(key), 'Unsupported bootstrap key'),
  z
    .string()
    .max(4096)
    .refine(value => !value.includes('\0'), 'Bootstrap values must not contain NUL')
);
const operationBase = {
  id: uuidSchema,
  allocationId: uuidSchema,
  sandboxId: z.string().min(1).max(256),
  providerRef: z
    .string()
    .max(128)
    .refine(value => decodeOnPremProviderRef(value) !== null, 'Invalid on-prem provider reference')
    .toLowerCase(),
  revision: integerSchema,
};

export const onPremOperationSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...operationBase,
        type: z.literal('launch'),
        profileId: identifierSchema,
        profileRevision: identifierSchema,
        hardStopAt: integerSchema,
        notAfter: integerSchema,
        bootstrap: bootstrapSchema,
      })
      .strict(),
    z.object({ ...operationBase, type: z.literal('stop'), reason: diagnosticCodeSchema }).strict(),
  ])
  .refine(
    value => decodeOnPremProviderRef(value.providerRef)?.allocationId === value.allocationId,
    {
      path: ['providerRef'],
      message: 'Provider reference must match the allocation',
    }
  );

export const onPremReportSchema = z
  .object({
    id: uuidSchema,
    allocationId: uuidSchema,
    revision: integerSchema,
    observedAt: integerSchema,
    status: z.enum(['pending', 'active', 'terminal', 'unknown', 'rejected']),
    pod: z
      .object({
        namespace: dnsLabelSchema,
        name: dnsSubdomainSchema,
        uid: identifierSchema,
        ip: z.union([z.ipv4(), z.ipv6()]).optional(),
      })
      .strict()
      .optional(),
    diagnosticCode: diagnosticCodeSchema.optional(),
  })
  .strict();

export const onPremExchangeRequestSchema = z
  .object({
    protocolVersion: z.literal(ON_PREM_PROTOCOL_VERSION),
    runnerVersion: runnerVersionSchema,
    ready: z.boolean(),
    diagnosticCode: diagnosticCodeSchema.nullable(),
    instanceTypes: onPremInstanceTypesSchema.optional(),
    reports: z.array(onPremReportSchema).max(ON_PREM_MAX_BATCH_SIZE),
  })
  .strict();

export const onPremExchangeResponseSchema = z
  .object({
    protocolVersion: z.literal(ON_PREM_PROTOCOL_VERSION),
    serverTime: integerSchema,
    revoked: z.boolean(),
    acknowledgedReportIds: z.array(uuidSchema).max(ON_PREM_MAX_BATCH_SIZE),
    operations: z.array(onPremOperationSchema).max(ON_PREM_MAX_BATCH_SIZE),
    pollAfterMs: z.number().int().min(1000).max(60_000),
  })
  .strict();

export type OnPremProviderBinding = z.infer<typeof onPremProviderBindingSchema>;
export type OnPremProfile = z.infer<typeof onPremProfileSchema>;
export type OnPremInstanceResources = z.infer<typeof onPremInstanceResourcesSchema>;
export type OnPremInstanceType = z.infer<typeof onPremInstanceTypeSchema>;
export type OnPremInstanceTypes = z.infer<typeof onPremInstanceTypesSchema>;
export type OnPremInstallationStatus = z.infer<typeof onPremInstallationStatusSchema>;
export type OnPremStatus = z.infer<typeof onPremStatusSchema>;
export type OnPremEnrollmentRequest = z.infer<typeof onPremEnrollmentRequestSchema>;
export type OnPremEnrollmentResponse = z.infer<typeof onPremEnrollmentResponseSchema>;
export type OnPremSelectRequest = z.infer<typeof onPremSelectRequestSchema>;
export type OnPremRevokeRequest = z.infer<typeof onPremRevokeRequestSchema>;
export type OnPremEnrollRequest = z.infer<typeof onPremEnrollRequestSchema>;
export type OnPremEnrollResponse = z.infer<typeof onPremEnrollResponseSchema>;
export type OnPremOperation = z.infer<typeof onPremOperationSchema>;
export type OnPremReport = z.infer<typeof onPremReportSchema>;
export type OnPremExchangeRequest = z.infer<typeof onPremExchangeRequestSchema>;
export type OnPremExchangeResponse = z.infer<typeof onPremExchangeResponseSchema>;
