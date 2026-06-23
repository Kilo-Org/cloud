import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  security_findings,
  security_finding_notifications,
} from '@kilocode/db/schema';
import type { SecurityFindingNotificationKind } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { INTERNAL_API_SECRET, NEXTAUTH_URL } from '@/lib/config.server';
import { send as sendEmail, type TemplateName } from '@/lib/email';
import { securityFindingTemplateVars } from '@/lib/security-notification-email-vars';
import {
  SecurityNotificationPolicySchema,
  getEligibleSlaNotificationKind,
  meetsSecurityNotificationSeverityMinimum,
} from '@kilocode/worker-utils/security-notification-policy';

const SECRET_COMPARE_HMAC_KEY = Buffer.from('security-agent-notification-secret-compare');

const BodySchema = z
  .object({
    notificationId: z.string().uuid(),
  })
  .strict();

const notificationKindToTemplate = {
  new_finding: 'securityFindingNew',
  sla_warning: 'securityFindingSlaWarning',
  sla_breach: 'securityFindingSlaBreach',
} as const satisfies Record<SecurityFindingNotificationKind, TemplateName>;

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const left = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(provided).digest();
  const right = createHmac('sha256', SECRET_COMPARE_HMAC_KEY).update(expected).digest();
  return timingSafeEqual(left, right);
}

function formatDeadline(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC'
  );
}

function securityAgentUrl(
  finding: {
    ownedByOrganizationId: string | null;
    ownedByUserId: string | null;
  },
  path: string
): string {
  if (finding.ownedByOrganizationId) {
    return `${NEXTAUTH_URL}/organizations/${finding.ownedByOrganizationId}/security-agent/${path}`;
  }
  return `${NEXTAUTH_URL}/security-agent/${path}`;
}

function actionUrl(finding: {
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
}): string {
  return securityAgentUrl(finding, 'findings');
}

function manageNotificationsUrl(finding: {
  kind: 'new_finding' | 'sla_warning' | 'sla_breach';
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
}): string {
  const tab = finding.kind === 'new_finding' ? 'notifications' : 'sla';
  return securityAgentUrl(finding, `config?tab=${tab}`);
}

async function recipientStillAuthorized(row: {
  recipientUserId: string;
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
}): Promise<boolean> {
  if (row.ownedByUserId) return row.recipientUserId === row.ownedByUserId;
  if (!row.ownedByOrganizationId) return false;

  const [membership] = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, row.ownedByOrganizationId),
        eq(organization_memberships.kilo_user_id, row.recipientUserId),
        eq(organization_memberships.role, 'owner')
      )
    )
    .limit(1);

  return Boolean(membership);
}

async function loadCurrentConfig(row: {
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
}) {
  const ownerFilter = row.ownedByOrganizationId
    ? eq(agent_configs.owned_by_organization_id, row.ownedByOrganizationId)
    : row.ownedByUserId
      ? eq(agent_configs.owned_by_user_id, row.ownedByUserId)
      : undefined;
  if (!ownerFilter) return { kind: 'missing' as const };

  const [config] = await db
    .select({ isEnabled: agent_configs.is_enabled, config: agent_configs.config })
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.agent_type, 'security_scan'),
        eq(agent_configs.platform, 'github'),
        ownerFilter
      )
    )
    .limit(1);

  if (!config || !config.isEnabled) return { kind: 'disabled' as const };
  const parsed = SecurityNotificationPolicySchema.safeParse(config.config ?? {});
  if (!parsed.success) return { kind: 'malformed' as const };
  return { kind: 'enabled' as const, policy: parsed.data };
}

function isNotificationStillEligible(
  row: {
    kind: 'new_finding' | 'sla_warning' | 'sla_breach';
    findingStatus: string;
    severity: string;
    slaDueAt: string | null;
    ignoredReason: string | null;
  },
  policy: z.infer<typeof SecurityNotificationPolicySchema>
): boolean {
  if (row.findingStatus !== 'open') return false;
  if ((row.ignoredReason ?? '').startsWith('superseded:')) return false;
  if (row.kind === 'new_finding') {
    return (
      policy.new_finding_notifications_enabled &&
      meetsSecurityNotificationSeverityMinimum(
        row.severity,
        policy.new_finding_notification_min_severity
      )
    );
  }

  const kind = getEligibleSlaNotificationKind({
    status: row.findingStatus,
    isAgentEnabled: true,
    slaEnabled: policy.sla_enabled,
    slaNotificationsEnabled: policy.sla_notifications_enabled,
    severity: row.severity,
    minimumSeverity: policy.sla_notification_min_severity,
    slaDueAt: row.slaDueAt,
    warningDays: policy.sla_notification_warning_days,
    now: new Date(),
    isSuperseded: false,
  });

  return kind === row.kind;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || !secretMatches(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody: unknown = await req.json().catch(() => null);
  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const [row] = await db
    .select({
      notificationId: security_finding_notifications.id,
      kind: security_finding_notifications.kind,
      notificationStatus: security_finding_notifications.status,
      recipientUserId: security_finding_notifications.recipient_user_id,
      recipientEmail: kilocode_users.google_user_email,
      findingId: security_findings.id,
      ownedByOrganizationId: security_findings.owned_by_organization_id,
      ownedByUserId: security_findings.owned_by_user_id,
      repoFullName: security_findings.repo_full_name,
      findingStatus: security_findings.status,
      severity: security_findings.severity,
      title: security_findings.title,
      description: security_findings.description,
      cveId: security_findings.cve_id,
      ghsaId: security_findings.ghsa_id,
      cvssScore: security_findings.cvss_score,
      slaDueAt: security_findings.sla_due_at,
      ignoredReason: security_findings.ignored_reason,
    })
    .from(security_finding_notifications)
    .innerJoin(
      security_findings,
      eq(security_findings.id, security_finding_notifications.finding_id)
    )
    .innerJoin(
      kilocode_users,
      eq(kilocode_users.id, security_finding_notifications.recipient_user_id)
    )
    .where(eq(security_finding_notifications.id, parsedBody.data.notificationId))
    .limit(1);

  if (!row || row.notificationStatus !== 'sending') {
    return NextResponse.json({ outcome: 'cancelled', reason: 'not_sending' }, { status: 200 });
  }

  const config = await loadCurrentConfig(row);
  if (config.kind === 'malformed') {
    return NextResponse.json(
      { outcome: 'deferred', reason: 'invalid_notification_config' },
      { status: 200 }
    );
  }
  if (config.kind !== 'enabled') {
    return NextResponse.json(
      { outcome: 'cancelled', reason: 'security_agent_disabled' },
      { status: 200 }
    );
  }

  if (!(await recipientStillAuthorized(row))) {
    return NextResponse.json(
      { outcome: 'cancelled', reason: 'recipient_not_authorized' },
      { status: 200 }
    );
  }

  if (!isNotificationStillEligible(row, config.policy)) {
    return NextResponse.json(
      { outcome: 'cancelled', reason: 'finding_ineligible' },
      { status: 200 }
    );
  }

  if (!row.recipientEmail) {
    return NextResponse.json(
      { outcome: 'permanent_failure', reason: 'no_usable_email' },
      { status: 422 }
    );
  }

  const templateName = notificationKindToTemplate[row.kind];
  const result = await sendEmail({
    to: row.recipientEmail,
    templateName,
    templateVars: securityFindingTemplateVars({
      severity: row.severity,
      repositoryName: row.repoFullName,
      findingTitle: row.title,
      description: row.description,
      cveId: row.cveId,
      ghsaId: row.ghsaId,
      cvssScore: row.cvssScore,
      slaDeadline: formatDeadline(row.slaDueAt),
      actionUrl: actionUrl(row),
      manageNotificationsUrl: manageNotificationsUrl(row),
    }),
  }).catch(() => null);

  if (!result) {
    return NextResponse.json(
      { outcome: 'retryable_failure', reason: 'provider_unavailable' },
      { status: 503 }
    );
  }
  if (result.sent) return NextResponse.json({ outcome: 'sent' }, { status: 200 });
  if (result.reason === 'neverbounce_rejected') {
    return NextResponse.json(
      { outcome: 'permanent_failure', reason: 'email_verification_rejected' },
      { status: 422 }
    );
  }
  return NextResponse.json(
    { outcome: 'retryable_failure', reason: 'provider_unavailable' },
    { status: 503 }
  );
}
