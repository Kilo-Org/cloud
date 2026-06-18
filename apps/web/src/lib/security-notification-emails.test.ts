import { renderTemplate, subjects } from '@/lib/email';
import { securityFindingTemplateVars } from '@/lib/security-notification-email-vars';

jest.mock('@/lib/email-mailgun', () => ({
  getEmailVerificationRecipient: (email: string) => email,
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
      ...securityFindingTemplateVars({
        severity: 'high',
        repositoryName: 'acme/<script>alert(1)</script>',
        findingTitle: '<img src=x onerror=alert(1)>',
        description: 'A <strong>bad</strong> vulnerability',
        cveId: 'CVE-2026-0001',
        ghsaId: 'GHSA-aaaa-bbbb-cccc',
        cvssScore: 7.5,
        slaDeadline: 'Jun 14, 2026, 17:00 UTC',
        actionUrl: 'https://app.example.test/security-agent/findings',
        manageNotificationsUrl: 'https://app.example.test/security-agent/config?tab=notifications',
      }),
      year: '2026',
    });

    expect(html).toContain('acme/&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('A &lt;strong&gt;bad&lt;/strong&gt; vulnerability');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('A <strong>bad</strong> vulnerability');
  });

  it('renders linked finding metadata and Security Agent links', () => {
    const html = renderTemplate('securityFindingNew', {
      ...securityFindingTemplateVars({
        severity: 'critical',
        repositoryName: 'acme/api',
        findingTitle: 'SQL injection in repository search endpoint',
        description: 'Repository search input can alter SQL query structure.',
        cveId: 'CVE-2026-0001',
        ghsaId: 'GHSA-abcd-1234-wxyz',
        cvssScore: 9.8,
        actionUrl: 'https://app.example.test/security-agent/findings',
        manageNotificationsUrl: 'https://app.example.test/security-agent/config?tab=notifications',
      }),
      year: '2026',
    });

    expect(html).toContain('href="https://github.com/acme/api"');
    expect(html).toContain('href="https://www.cve.org/CVERecord?id=CVE-2026-0001"');
    expect(html).toContain('href="https://github.com/advisories/GHSA-ABCD-1234-WXYZ"');
    expect(html).toContain('CVSS 9.8');
    expect(html).toContain('Repository search input can alter SQL query structure.');
    expect(html).not.toContain('Description</td>');
    expect(html).toContain('Resolve with Security Agent');
    expect(html).toContain('href="https://app.example.test/security-agent/findings"');
    expect(html).toContain('Manage your security agent notifications');
    expect(html).toContain(
      'href="https://app.example.test/security-agent/config?tab=notifications"'
    );
    expect(html).not.toContain('Review findings');
  });

  it('links SLA notification management to the SLA tab', () => {
    const html = renderTemplate('securityFindingSlaWarning', {
      ...securityFindingTemplateVars({
        severity: 'critical',
        repositoryName: 'acme/api',
        findingTitle: 'Unauthenticated access to admin token exchange',
        description:
          'The admin token exchange endpoint accepts requests without a verified session.',
        cveId: 'CVE-2026-0002',
        ghsaId: 'GHSA-wxyz-1234-abcd',
        cvssScore: 9.8,
        slaDeadline: 'Jun 14, 2026, 17:00 UTC',
        actionUrl: 'https://app.example.test/security-agent/findings',
        manageNotificationsUrl: 'https://app.example.test/security-agent/config?tab=sla',
      }),
      year: '2026',
    });

    expect(html).toContain('Jun 14, 2026, 17:00 UTC');
    expect(html).toContain('href="https://app.example.test/security-agent/findings"');
    expect(html).toContain('Manage your security agent notifications');
    expect(html).not.toContain(
      'href="https://app.example.test/security-agent/config?tab=notifications"'
    );
    expect(html).toContain('href="https://app.example.test/security-agent/config?tab=sla"');
  });

  it('renders missing advisory IDs without broken links', () => {
    const html = renderTemplate('securityFindingNew', {
      ...securityFindingTemplateVars({
        severity: 'high',
        repositoryName: 'acme/api',
        findingTitle: 'Prototype Pollution in lodash',
        description: null,
        cveId: null,
        ghsaId: null,
        cvssScore: null,
        actionUrl: 'https://app.example.test/security-agent/findings',
        manageNotificationsUrl: 'https://app.example.test/security-agent/config?tab=notifications',
      }),
      year: '2026',
    });

    expect(html).toContain('Not reported');
    expect(html).toContain('No description provided.');
    expect(html).not.toContain('https://www.cve.org/CVERecord?id=');
    expect(html).not.toContain('https://github.com/advisories/</a>');
  });
});
