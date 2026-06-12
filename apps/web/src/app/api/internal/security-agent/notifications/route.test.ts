import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { RawHtml, send as sendEmail } from '@/lib/email';
import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  organizations,
  security_findings,
  security_finding_notifications,
} from '@kilocode/db/schema';
import {
  SecurityFindingNotificationKind,
  SecurityFindingNotificationStatus,
} from '@kilocode/db/schema-types';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'security-notification-secret',
  NEXTAUTH_URL: 'https://app.example.test',
}));

jest.mock('@/lib/email', () => {
  const actual = jest.requireActual('@/lib/email');
  return {
    ...actual,
    send: jest.fn(),
  };
});

import { POST } from './route';

const mockSendEmail = jest.mocked(sendEmail);

function createRequest(notificationId: string, secret = 'security-notification-secret') {
  return new NextRequest('http://localhost:3000/api/internal/security-agent/notifications', {
    method: 'POST',
    body: JSON.stringify({ notificationId }),
    headers: {
      'content-type': 'application/json',
      'X-Internal-Secret': secret,
    },
  });
}

function createRawRequest(body: unknown, secret = 'security-notification-secret') {
  return new NextRequest('http://localhost:3000/api/internal/security-agent/notifications', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'X-Internal-Secret': secret,
    },
  });
}

async function insertPersonalNotification(params: {
  kind?: SecurityFindingNotificationKind;
  status?: SecurityFindingNotificationStatus;
  config?: Record<string, unknown>;
  finding?: Partial<typeof security_findings.$inferInsert>;
  user?: Partial<typeof kilocode_users.$inferInsert>;
}) {
  const user = await insertTestUser(params.user);
  await db.insert(agent_configs).values({
    owned_by_user_id: user.id,
    agent_type: 'security_scan',
    platform: 'github',
    config: params.config ?? { new_finding_notifications_enabled: true },
    is_enabled: true,
    created_by: user.id,
  });
  const [finding] = await db
    .insert(security_findings)
    .values({
      owned_by_user_id: user.id,
      repo_full_name: 'acme/api',
      source: 'dependabot',
      source_id: crypto.randomUUID(),
      severity: 'high',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      title: 'Prototype Pollution in lodash',
      description: 'Lodash merge allows prototype pollution through crafted payloads.',
      cve_id: 'CVE-2026-0001',
      ghsa_id: 'GHSA-aaaa-bbbb-cccc',
      cvss_score: '7.5',
      status: 'open',
      ...params.finding,
    })
    .returning();
  const status = params.status ?? SecurityFindingNotificationStatus.Sending;
  const [notification] = await db
    .insert(security_finding_notifications)
    .values({
      finding_id: finding.id,
      recipient_user_id: user.id,
      kind: params.kind ?? SecurityFindingNotificationKind.NewFinding,
      status,
      claimed_at:
        status === SecurityFindingNotificationStatus.Sending ? new Date().toISOString() : null,
    })
    .returning();

  return { user, finding, notification };
}

async function insertOrganizationNotification(params: {
  membershipRole: 'owner' | 'member';
  kind?: SecurityFindingNotificationKind;
}) {
  const owner = await insertTestUser();
  const recipient = await insertTestUser();
  const [organization] = await db
    .insert(organizations)
    .values({
      name: `Security Notifications ${crypto.randomUUID()}`,
      created_by_kilo_user_id: owner.id,
    })
    .returning();
  await db.insert(organization_memberships).values([
    { organization_id: organization.id, kilo_user_id: owner.id, role: 'owner' },
    { organization_id: organization.id, kilo_user_id: recipient.id, role: params.membershipRole },
  ]);
  await db.insert(agent_configs).values({
    owned_by_organization_id: organization.id,
    agent_type: 'security_scan',
    platform: 'github',
    config: { new_finding_notifications_enabled: true },
    is_enabled: true,
    created_by: owner.id,
  });
  const [finding] = await db
    .insert(security_findings)
    .values({
      owned_by_organization_id: organization.id,
      repo_full_name: 'acme/org-api',
      source: 'dependabot',
      source_id: crypto.randomUUID(),
      severity: 'critical',
      package_name: 'express',
      package_ecosystem: 'npm',
      title: 'Unauthenticated admin token exchange',
      status: 'open',
    })
    .returning();
  const [notification] = await db
    .insert(security_finding_notifications)
    .values({
      finding_id: finding.id,
      recipient_user_id: recipient.id,
      kind: params.kind ?? SecurityFindingNotificationKind.NewFinding,
      status: SecurityFindingNotificationStatus.Sending,
      claimed_at: new Date().toISOString(),
    })
    .returning();

  return { organization, recipient, notification };
}

describe('POST /api/internal/security-agent/notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue({ sent: true });
  });

  afterEach(async () => {
    await db.delete(security_finding_notifications).where(sql`true`);
    await db.delete(security_findings).where(sql`true`);
    await db.delete(agent_configs).where(sql`true`);
    await db.delete(organization_memberships).where(sql`true`);
    await db.delete(organizations).where(sql`true`);
    await db.delete(kilocode_users).where(sql`true`);
  });

  it('returns 401 when internal secret is wrong', async () => {
    const { notification } = await insertPersonalNotification({});

    const response = await POST(createRequest(notification.id, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects request bodies with extra fields', async () => {
    const { notification } = await insertPersonalNotification({});

    const response = await POST(createRawRequest({ notificationId: notification.id, email: 'x' }));

    expect(response.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends eligible personal new-finding notifications', async () => {
    const { notification, user } = await insertPersonalNotification({});

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'sent' });
    expect(mockSendEmail).toHaveBeenCalledWith({
      to: user.google_user_email,
      templateName: 'securityFindingNew',
      templateVars: {
        severity: 'high',
        repository_name: 'acme/api',
        finding_title: 'Prototype Pollution in lodash',
        finding_description: 'Lodash merge allows prototype pollution through crafted payloads.',
        finding_details: expect.any(RawHtml),
        sla_deadline: '',
        action_url: 'https://app.example.test/security-agent/findings',
        manage_notifications_url:
          'https://app.example.test/security-agent/config?tab=notifications',
      },
    });
    const sentEmail = mockSendEmail.mock.calls[0]?.[0];
    const findingDetails = sentEmail?.templateVars.finding_details;
    expect(findingDetails).toBeInstanceOf(RawHtml);
    if (!(findingDetails instanceof RawHtml)) throw new Error('Expected finding details HTML');
    expect(findingDetails.html).toContain('href="https://github.com/acme/api"');
    expect(findingDetails.html).toContain('href="https://www.cve.org/CVERecord?id=CVE-2026-0001"');
    expect(findingDetails.html).toContain(
      'href="https://github.com/advisories/GHSA-AAAA-BBBB-CCCC"'
    );
    expect(findingDetails.html).toContain('CVSS 7.5');
    expect(findingDetails.html).not.toContain('Lodash merge allows prototype pollution');
  });

  it('cancels new-finding notifications when they are disabled by default', async () => {
    const { notification } = await insertPersonalNotification({ config: {} });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'finding_ineligible',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('defers when current notification config is malformed', async () => {
    const { notification } = await insertPersonalNotification({
      config: { new_finding_notifications_enabled: true, sla_notification_warning_days: 0 },
    });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'deferred',
      reason: 'invalid_notification_config',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('cancels organization notifications when recipient is not an owner', async () => {
    const { notification } = await insertOrganizationNotification({ membershipRole: 'member' });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'recipient_not_authorized',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends organization notifications to current organization owners', async () => {
    const { organization, recipient, notification } = await insertOrganizationNotification({
      membershipRole: 'owner',
    });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'sent' });
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: recipient.google_user_email,
        templateName: 'securityFindingNew',
        templateVars: expect.objectContaining({
          action_url: `https://app.example.test/organizations/${organization.id}/security-agent/findings`,
          manage_notifications_url: `https://app.example.test/organizations/${organization.id}/security-agent/config?tab=notifications`,
        }),
      })
    );
  });

  it('cancels SLA warning notifications after breach boundary', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const { notification } = await insertPersonalNotification({
      kind: SecurityFindingNotificationKind.SlaWarning,
      config: { new_finding_notifications_enabled: true, sla_notifications_enabled: true },
      finding: { sla_due_at: dueAt },
    });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'finding_ineligible',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends SLA notification management links to the SLA tab', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const { notification } = await insertPersonalNotification({
      kind: SecurityFindingNotificationKind.SlaBreach,
      config: { new_finding_notifications_enabled: true, sla_notifications_enabled: true },
      finding: { sla_due_at: dueAt },
    });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'sent' });
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'securityFindingSlaBreach',
        templateVars: expect.objectContaining({
          action_url: 'https://app.example.test/security-agent/findings',
          manage_notifications_url: 'https://app.example.test/security-agent/config?tab=sla',
        }),
      })
    );
  });

  it('returns permanent failure when recipient email is unavailable', async () => {
    const { notification } = await insertPersonalNotification({
      user: { google_user_email: '' },
    });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      outcome: 'permanent_failure',
      reason: 'no_usable_email',
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns retryable failure when email provider throws', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('mailgun unavailable'));
    const { notification } = await insertPersonalNotification({});

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      outcome: 'retryable_failure',
      reason: 'provider_unavailable',
    });
  });

  it('returns cancelled when notification was no longer claimed', async () => {
    const { notification } = await insertPersonalNotification({
      status: SecurityFindingNotificationStatus.Pending,
    });

    const response = await POST(createRequest(notification.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'cancelled', reason: 'not_sending' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('persists no mutation itself; sweep owns state transition', async () => {
    const { notification } = await insertPersonalNotification({});

    await POST(createRequest(notification.id));

    const [row] = await db
      .select()
      .from(security_finding_notifications)
      .where(
        and(
          eq(security_finding_notifications.id, notification.id),
          eq(security_finding_notifications.status, SecurityFindingNotificationStatus.Sending)
        )
      );
    expect(row).toBeDefined();
  });
});
