import { NextRequest } from 'next/server';
import { send as sendEmail, RawHtml } from '@/lib/email';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'kc-internal-secret',
}));

jest.mock('@/lib/email', () => ({
  send: jest.fn(),
  RawHtml: jest.requireActual('@/lib/email').RawHtml,
}));

import { POST } from './route';

const mockSendEmail = jest.mocked(sendEmail);

function bodyFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notificationId: crypto.randomUUID(),
    kind: 'notice',
    channel: 'email',
    targetId: crypto.randomUUID(),
    scheduledActionId: crypto.randomUUID(),
    actionType: 'scheduled_restart',
    userId: 'user_123',
    userEmail: 'u@example.com',
    userName: 'Sample User',
    instanceId: crypto.randomUUID(),
    instanceSandboxId: 'ki_abc',
    instanceName: 'My Bot',
    sourceImageTag: null,
    sourceOpenclawVersion: null,
    targetImageTag: null,
    targetOpenclawVersion: null,
    overridePins: false,
    scheduledAt: '2026-05-04T18:55:00Z',
    noticeLeadHours: 24,
    noticeSubject: 'Restart tonight',
    noticeBody: 'Heads up: maintenance window',
    reason: null,
    ...overrides,
  };
}

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(
    'http://localhost:3000/api/internal/kiloclaw/scheduled-action-side-effects',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'X-Internal-Secret': 'kc-internal-secret',
        ...headers,
      },
    }
  );
}

describe('POST /api/internal/kiloclaw/scheduled-action-side-effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue({ sent: true });
  });

  it('returns 401 when X-Internal-Secret is missing', async () => {
    const res = await POST(
      new NextRequest('http://localhost:3000/api/internal/kiloclaw/scheduled-action-side-effects', {
        method: 'POST',
        body: JSON.stringify(bodyFor()),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Internal-Secret is wrong', async () => {
    const res = await POST(createRequest(bodyFor(), { 'X-Internal-Secret': 'wrong' }));
    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 400 when the body fails schema validation', async () => {
    const res = await POST(createRequest({ notificationId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 400 for non-email channels (sweep should never route them here)', async () => {
    const res = await POST(createRequest(bodyFor({ channel: 'mobile_push' })));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain('mobile_push');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 422 when userEmail is null so the sweep marks the row failed (not sent)', async () => {
    const res = await POST(createRequest(bodyFor({ userEmail: null })));
    expect(res.status).toBe(422);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 422 when send returns sent:false', async () => {
    mockSendEmail.mockResolvedValueOnce({ sent: false, reason: 'provider_not_configured' });
    const res = await POST(createRequest(bodyFor()));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain('provider_not_configured');
  });

  it('returns 502 when send throws', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('mailgun timeout'));
    const res = await POST(createRequest(bodyFor()));
    expect(res.status).toBe(502);
  });

  it('uses the admin-authored subject as subjectOverride for notice emails', async () => {
    const res = await POST(
      createRequest(bodyFor({ kind: 'notice', noticeSubject: 'Restart tonight' }))
    );
    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subjectOverride: 'Restart tonight' })
    );
  });

  it('does NOT reuse the notice subject for cancellation emails (template default is correct)', async () => {
    const res = await POST(
      createRequest(bodyFor({ kind: 'cancelled', noticeSubject: 'Restart tonight' }))
    );
    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0];
    // The route must hand subjectOverride: undefined for cancellations
    // so the cancellation template's default subject takes effect.
    expect(call.subjectOverride).toBeUndefined();
  });

  it('routes restart notice to clawScheduledRestartNotice template', async () => {
    await POST(createRequest(bodyFor({ kind: 'notice', actionType: 'scheduled_restart' })));
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'clawScheduledRestartNotice' })
    );
  });

  it('routes version_change cancellation to clawScheduledVersionChangeCancelled template', async () => {
    await POST(createRequest(bodyFor({ kind: 'cancelled', actionType: 'version_change' })));
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'clawScheduledVersionChangeCancelled' })
    );
  });

  it('renders instance name in templateVars when provided', async () => {
    await POST(createRequest(bodyFor({ instanceName: 'Cool Bot' })));
    const vars = mockSendEmail.mock.calls[0][0].templateVars as Record<string, unknown>;
    expect(vars.instance_name).toBe('Cool Bot');
  });

  it('falls back to sandbox id when instanceName is null', async () => {
    await POST(createRequest(bodyFor({ instanceName: null })));
    const vars = mockSendEmail.mock.calls[0][0].templateVars as Record<string, unknown>;
    expect(vars.instance_name).toBe('ki_abc');
  });

  it('escapes html in admin-authored noticeBody so admins cannot inject markup', async () => {
    await POST(createRequest(bodyFor({ noticeBody: '<script>alert(1)</script>\nSecond line' })));
    const vars = mockSendEmail.mock.calls[0][0].templateVars as Record<string, unknown>;
    const adminSection = vars.admin_message_section;
    expect(adminSection).toBeInstanceOf(RawHtml);
    const html = (adminSection as RawHtml).html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // newline → <br /> in the escaped body
    expect(html).toContain('<br />');
  });
});
