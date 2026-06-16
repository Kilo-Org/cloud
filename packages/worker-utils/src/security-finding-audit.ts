import { security_audit_log } from '@kilocode/db/schema';
import type { SecurityAuditLogEntry } from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
  SecuritySeverity,
} from '@kilocode/db/schema-types';
import * as z from 'zod';

export const SECURITY_FINDING_AUDIT_SCHEMA_VERSION = 1;
export const SECURITY_FINDING_AUDIT_EVENT_KEY_PREFIX = 'security_finding_audit:v1';

export const REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS = [
  SecurityAuditLogAction.FindingCreated,
  SecurityAuditLogAction.FindingSeverityChanged,
  SecurityAuditLogAction.FindingStatusChange,
  SecurityAuditLogAction.FindingDismissed,
  SecurityAuditLogAction.FindingAutoDismissed,
  SecurityAuditLogAction.FindingSuperseded,
  SecurityAuditLogAction.FindingAnalysisCompleted,
  SecurityAuditLogAction.FindingAnalysisFailed,
  SecurityAuditLogAction.RemediationQueued,
  SecurityAuditLogAction.RemediationPrOpened,
  SecurityAuditLogAction.RemediationFailed,
  SecurityAuditLogAction.RemediationBlocked,
  SecurityAuditLogAction.RemediationNoChangesNeeded,
  SecurityAuditLogAction.RemediationCancelled,
  SecurityAuditLogAction.FindingDeleted,
] as const;

const ReportableSecurityFindingAuditActionSchema = z
  .nativeEnum(SecurityAuditLogAction)
  .refine(
    (action): action is (typeof REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS)[number] =>
      REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS.includes(
        action as (typeof REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS)[number]
      ),
    'Action is not reportable Security Finding activity'
  );

const IsoTimestampSchema = z.string().datetime({ offset: true });
const NonEmptyStringSchema = z.string().trim().min(1);
const UuidSchema = z.string().uuid();

export const SecurityFindingAuditOwnerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: NonEmptyStringSchema }),
  z.object({ type: z.literal('organization'), organizationId: UuidSchema }),
]);

export type SecurityFindingAuditOwner = z.infer<typeof SecurityFindingAuditOwnerSchema>;

type SanitizedJsonValue =
  | string
  | number
  | boolean
  | null
  | SanitizedJsonValue[]
  | { [key: string]: SanitizedJsonValue };

const SanitizedJsonValueSchema: z.ZodType<SanitizedJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(SanitizedJsonValueSchema),
    z.record(z.string(), SanitizedJsonValueSchema),
  ])
);

const SanitizedJsonObjectSchema = z
  .record(z.string(), SanitizedJsonValueSchema)
  .superRefine((value, ctx) => {
    validateSafeAuditJson(value, ctx);
  });

export const SecurityFindingAuditSnapshotSchema = z
  .object({
    finding_id: UuidSchema,
    source: NonEmptyStringSchema,
    source_id: NonEmptyStringSchema,
    repo_full_name: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    severity: z.enum([
      SecuritySeverity.CRITICAL,
      SecuritySeverity.HIGH,
      SecuritySeverity.MEDIUM,
      SecuritySeverity.LOW,
    ]),
    status: NonEmptyStringSchema,
    package_name: NonEmptyStringSchema.optional(),
    package_ecosystem: NonEmptyStringSchema.optional(),
    manifest_path: NonEmptyStringSchema.optional(),
    patched_version: NonEmptyStringSchema.optional(),
    ghsa_id: NonEmptyStringSchema.optional(),
    cve_id: NonEmptyStringSchema.optional(),
    cwe_ids: z.array(NonEmptyStringSchema).optional(),
    cvss_score: z.union([z.string(), z.number().finite()]).optional(),
    dependabot_html_url: z.string().url().optional(),
    first_detected_at: IsoTimestampSchema,
    fixed_at: IsoTimestampSchema.nullable(),
    sla_due_at: IsoTimestampSchema.nullable(),
    canonical_finding_id: UuidSchema.optional(),
    remediation_attempt_id: UuidSchema.optional(),
    session_id: NonEmptyStringSchema.optional(),
    notification_id: UuidSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateSafeAuditJson(value, ctx);
  });

export type SecurityFindingAuditSnapshot = z.infer<typeof SecurityFindingAuditSnapshotSchema>;

export type SecurityFindingAuditSnapshotSource = {
  id: string;
  source: string;
  source_id: string;
  repo_full_name: string;
  title: string;
  severity: string;
  status: string;
  package_name?: string | null;
  package_ecosystem?: string | null;
  manifest_path?: string | null;
  patched_version?: string | null;
  ghsa_id?: string | null;
  cve_id?: string | null;
  cwe_ids?: string[] | null;
  cvss_score?: string | number | null;
  dependabot_html_url?: string | null;
  first_detected_at: string | Date;
  fixed_at: string | Date | null;
  sla_due_at: string | Date | null;
  session_id?: string | null;
};

export type SecurityFindingAuditSnapshotExtras = {
  canonical_finding_id?: string | null;
  remediation_attempt_id?: string | null;
  session_id?: string | null;
  notification_id?: string | null;
};

export type SecurityFindingAuditEventFinding = SecurityFindingAuditSnapshotSource & {
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
};

export const SecurityFindingAuditEventSchema = z.object({
  owner: SecurityFindingAuditOwnerSchema,
  finding: z.object({
    id: UuidSchema,
    owned_by_user_id: z.string().min(1).nullable(),
    owned_by_organization_id: UuidSchema.nullable(),
  }),
  actor: z
    .object({
      id: z.string().min(1).nullable(),
      email: z.string().email().nullable(),
      name: z.string().min(1).nullable(),
    })
    .nullable()
    .optional(),
  action: ReportableSecurityFindingAuditActionSchema,
  occurredAt: IsoTimestampSchema,
  sourceOccurredAt: IsoTimestampSchema.nullable().optional(),
  eventKey: NonEmptyStringSchema,
  sourceContext: z.nativeEnum(SecurityFindingAuditSourceContext),
  snapshot: SecurityFindingAuditSnapshotSchema,
  beforeState: SanitizedJsonObjectSchema.optional(),
  afterState: SanitizedJsonObjectSchema.optional(),
  metadata: SanitizedJsonObjectSchema.optional(),
});

export type SecurityFindingAuditEventInput = {
  owner: SecurityFindingAuditOwner;
  finding: SecurityFindingAuditEventFinding;
  actor?: {
    id: string | null;
    email: string | null;
    name: string | null;
  } | null;
  action: SecurityAuditLogAction;
  occurredAt: string | Date;
  sourceOccurredAt?: string | Date | null;
  eventKey: string;
  sourceContext: SecurityFindingAuditSourceContext;
  snapshot?: SecurityFindingAuditSnapshot;
  snapshotExtras?: SecurityFindingAuditSnapshotExtras;
  beforeState?: Record<string, SanitizedJsonValue>;
  afterState?: Record<string, SanitizedJsonValue>;
  metadata?: Record<string, SanitizedJsonValue>;
};

export type NewSecurityFindingAuditLogValues = typeof security_audit_log.$inferInsert;

type SecurityFindingAuditInsertReturning = {
  returning(selection: { id: typeof security_audit_log.id }): Promise<Array<{ id: string }>>;
};

type SecurityFindingAuditInsertConflict = {
  onConflictDoNothing(): SecurityFindingAuditInsertReturning;
};

type SecurityFindingAuditInsertValues = {
  values(values: NewSecurityFindingAuditLogValues): SecurityFindingAuditInsertConflict;
};

export type SecurityFindingAuditWriterDb = {
  insert(table: typeof security_audit_log): SecurityFindingAuditInsertValues;
};

export function buildSecurityFindingAuditSnapshot(
  finding: SecurityFindingAuditSnapshotSource,
  extras: SecurityFindingAuditSnapshotExtras = {}
): SecurityFindingAuditSnapshot {
  const snapshot = {
    finding_id: finding.id,
    source: finding.source,
    source_id: finding.source_id,
    repo_full_name: finding.repo_full_name,
    title: finding.title,
    severity: finding.severity,
    status: finding.status,
    first_detected_at: normalizeAuditTimestamp(finding.first_detected_at),
    fixed_at: normalizeAuditTimestamp(finding.fixed_at) ?? null,
    sla_due_at: normalizeAuditTimestamp(finding.sla_due_at) ?? null,
    ...pickPresent({
      package_name: finding.package_name,
      package_ecosystem: finding.package_ecosystem,
      manifest_path: finding.manifest_path,
      patched_version: finding.patched_version,
      ghsa_id: finding.ghsa_id,
      cve_id: finding.cve_id,
      cwe_ids: finding.cwe_ids,
      cvss_score: finding.cvss_score,
      dependabot_html_url: finding.dependabot_html_url,
      canonical_finding_id: extras.canonical_finding_id,
      remediation_attempt_id: extras.remediation_attempt_id,
      session_id: extras.session_id ?? finding.session_id,
      notification_id: extras.notification_id,
    }),
  };

  return SecurityFindingAuditSnapshotSchema.parse(snapshot);
}

export function buildSecurityFindingAuditLogValues(
  input: SecurityFindingAuditEventInput
): NewSecurityFindingAuditLogValues {
  const snapshot =
    input.snapshot ?? buildSecurityFindingAuditSnapshot(input.finding, input.snapshotExtras);
  const occurredAt = normalizeAuditTimestamp(input.occurredAt);
  if (!occurredAt) throw new Error('occurredAt is required');

  const sourceOccurredAt = normalizeAuditTimestamp(input.sourceOccurredAt);
  const parsed = SecurityFindingAuditEventSchema.parse({
    owner: input.owner,
    finding: {
      id: input.finding.id,
      owned_by_user_id: input.finding.owned_by_user_id,
      owned_by_organization_id: input.finding.owned_by_organization_id,
    },
    actor: input.actor,
    action: input.action,
    occurredAt,
    sourceOccurredAt,
    eventKey: input.eventKey,
    sourceContext: input.sourceContext,
    snapshot,
    beforeState: input.beforeState,
    afterState: input.afterState,
    metadata: input.metadata,
  });

  assertFindingOwnerMatchesEventOwner(parsed.owner, input.finding);
  if (parsed.snapshot.finding_id !== input.finding.id) {
    throw new Error('Security Finding audit snapshot finding_id must match finding_id');
  }

  const ownerColumns = getAuditOwnerColumns(parsed.owner);

  return {
    ...ownerColumns,
    actor_id: parsed.actor?.id ?? null,
    actor_email: parsed.actor?.email ?? null,
    actor_name: parsed.actor?.name ?? null,
    action: parsed.action,
    resource_type: 'security_finding',
    resource_id: input.finding.id,
    before_state: parsed.beforeState,
    after_state: parsed.afterState,
    metadata: parsed.metadata,
    finding_id: input.finding.id,
    occurred_at: parsed.occurredAt,
    source_occurred_at: parsed.sourceOccurredAt ?? null,
    event_key: parsed.eventKey,
    schema_version: SECURITY_FINDING_AUDIT_SCHEMA_VERSION,
    finding_snapshot: parsed.snapshot,
    source_context: parsed.sourceContext,
  };
}

export async function insertSecurityFindingAuditEvent(
  db: SecurityFindingAuditWriterDb,
  input: SecurityFindingAuditEventInput
): Promise<{ inserted: boolean; id: string | null }> {
  const values = buildSecurityFindingAuditLogValues(input);
  const inserted = await db
    .insert(security_audit_log)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: security_audit_log.id });

  return { inserted: inserted.length > 0, id: inserted[0]?.id ?? null };
}

export function deriveSecurityFindingAuditEventKey(parts: readonly string[]): string {
  if (parts.length === 0) throw new Error('Security Finding audit event key requires parts');
  return [
    SECURITY_FINDING_AUDIT_EVENT_KEY_PREFIX,
    ...parts.map(part => encodeURIComponent(part)),
  ].join(':');
}

function assertFindingOwnerMatchesEventOwner(
  owner: SecurityFindingAuditOwner,
  finding: Pick<
    SecurityFindingAuditEventFinding,
    'owned_by_user_id' | 'owned_by_organization_id' | 'id'
  >
): void {
  if (owner.type === 'user') {
    if (finding.owned_by_user_id !== owner.userId || finding.owned_by_organization_id !== null) {
      throw new Error('Security Finding audit event owner does not match finding owner');
    }
    return;
  }

  if (
    finding.owned_by_organization_id !== owner.organizationId ||
    finding.owned_by_user_id !== null
  ) {
    throw new Error('Security Finding audit event owner does not match finding owner');
  }
}

function getAuditOwnerColumns(owner: SecurityFindingAuditOwner): {
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
} {
  if (owner.type === 'user') {
    return { owned_by_user_id: owner.userId, owned_by_organization_id: null };
  }
  return { owned_by_user_id: null, owned_by_organization_id: owner.organizationId };
}

function normalizeAuditTimestamp(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid audit timestamp: ${String(value)}`);
  return date.toISOString();
}

function pickPresent<T extends Record<string, unknown>>(values: T): Partial<T> {
  const entries = Object.entries(values).filter(([, value]) => {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return value !== '';
  });
  return Object.fromEntries(entries) as Partial<T>;
}

const DISALLOWED_AUDIT_JSON_KEY_PATTERN =
  /(^|_)(actor|recipient|email|prompt|rawmarkdown|raw_markdown|transcript|assistant|provider_response|authorization|auth_header|cookie|token|secret|password|credential|headers|raw_error)(_|$)/i;
const EMAIL_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function validateSafeAuditJson(
  value: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[] = []
) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateSafeAuditJson(item, ctx, [...path, index]);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (DISALLOWED_AUDIT_JSON_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Audit JSON field is not allowed: ${childPath.join('.')}`,
          path: childPath,
        });
      }
      validateSafeAuditJson(child, ctx, childPath);
    }
    return;
  }

  if (typeof value === 'string' && EMAIL_VALUE_PATTERN.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Audit JSON value appears to contain an email address: ${path.join('.')}`,
      path,
    });
  }
}

export type SecurityFindingAuditLogEntry = SecurityAuditLogEntry;
