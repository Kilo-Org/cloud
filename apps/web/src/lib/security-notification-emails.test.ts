import { renderTemplate, subjects } from '@/lib/email';

jest.mock('@/lib/email-mailgun', () => ({
  sendViaMailgun: jest.fn(),
}));

jest.mock('@/lib/email-neverbounce', () => ({
  verifyEmail: jest.fn(),
}));

describe('Security Agent notification emails', () => {
  it('registers canonical Security Agent notification subjects', () => {
    expect(subjects).toMatchObject({
      securityFindingNew: 'Kilo Security Agent: New finding',
      securityFindingSlaWarning: 'Kilo Security Agent: SLA warning',
      securityFindingSlaBreach: 'Kilo Security Agent: SLA breached',
    });
  });

  it('escapes repository and title values in rendered templates', () => {
    const html = renderTemplate('securityFindingSlaWarning', {
      severity: 'high',
      repository_name: 'acme/<script>alert(1)</script>',
      finding_title: '<img src=x onerror=alert(1)>',
      sla_deadline: 'Jun 14, 2026, 17:00 UTC',
      action_url: 'https://app.example.test/security-agent/findings',
      year: '2026',
    });

    expect(html).toContain('acme/&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
