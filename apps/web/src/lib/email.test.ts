import { renderNonAutolinkedText, renderTemplate, subjects } from '@/lib/email';

describe('email rendering helpers', () => {
  it('escapes HTML while neutralizing URL autolinking', () => {
    const rendered = renderNonAutolinkedText(
      '<b>https://evil.example</b> www.bad.example acme.com'
    );

    expect(rendered.html).toBe(
      '&lt;b&gt;https:/&#8203;/&#8203;evil.&#8203;example&lt;/&#8203;b&gt; www.&#8203;bad.&#8203;example acme.&#8203;com'
    );
  });
});

describe('user data export ready email', () => {
  it('uses the required subject and only links to the authenticated export page', () => {
    expect(subjects.userDataExportReady).toBe('Your Kilo account export is ready');
    const html = renderTemplate('userDataExportReady', {
      data_exports_url: 'https://app.kilocode.ai/data-exports',
      expiry_date: 'August 15, 2026',
      year: '2026',
    });
    expect(html).toContain('https://app.kilocode.ai/data-exports');
    expect(html).not.toContain('signed');
  });
});

describe('data export download code email', () => {
  it('carries the code and no link that could stand in for it', () => {
    expect(subjects.dataExportDownloadCode).toBe('Your Kilo data export download code');
    const html = renderTemplate('dataExportDownloadCode', {
      code: '482913',
      email: 'user@example.com',
      expires_in: '10 minutes',
      year: '2026',
    });

    expect(html).toContain('482913');
    expect(html).toContain('10 minutes');
    // The code must be the only way to act on this email.
    expect(html).not.toContain('href');
  });
});
