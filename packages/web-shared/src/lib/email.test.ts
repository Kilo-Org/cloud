jest.mock('@sentry/nextjs', () => ({
  ...(jest.requireActual('@sentry/nextjs') as Record<string, unknown>),
  captureException: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/email-mailgun', () => ({
  getEmailVerificationRecipient: jest.fn(() => null),
  sendViaMailgun: jest.fn().mockResolvedValue({}),
}));

import {
  RawHtml,
  renderNonAutolinkedText,
  renderTemplate,
  sendAccountDeletionCompletedEmail,
  sendAccountDeletionSupportNotification,
  sendKiloPassDuplicateCardCanceledEmail,
  sendSpendAlertEmail,
  subjects,
  sendCreditsTopUpEmail,
} from '@kilocode/web-shared/lib/email';
import { captureException } from '@sentry/nextjs';
import { sendViaMailgun } from '@kilocode/web-shared/lib/email-mailgun';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { USER_DELETION_COMPLETION_HTML } from '@kilocode/web-shared/lib/user/deletion-queue/deletion-constants';

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

describe('credit purchase expiration email', () => {
  it.each([
    {
      creditExpiryDate: new Date('2027-02-28T12:34:00.000Z'),
      expectedDate: 'February 28, 2027',
      expectedLabel: 'Purchased credits expire',
    },
    {
      creditExpiryDate: null,
      expectedDate: 'No expiration.',
      expectedLabel: 'Purchased credits',
    },
  ])(
    'uses the persisted deadline $creditExpiryDate',
    async ({ creditExpiryDate, expectedDate, expectedLabel }) => {
      jest.clearAllMocks();
      await sendCreditsTopUpEmail({
        to: 'purchase@example.com',
        variant: 'manual',
        principalCents: 2000,
        serviceFeeCents: 0,
        grossPaidCents: 2000,
        creditsCents: 2000,
        purchaseDate: new Date('2026-02-28T12:34:00.000Z'),
        creditExpiryDate,
      });

      expect(sendViaMailgun).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'creditsTopUp',
          html: expect.stringContaining(expectedDate),
        })
      );
      expect(sendViaMailgun).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining(expectedLabel),
        })
      );
    }
  );
});

describe('template loading', () => {
  it.each([undefined, 'other@example.com'])(
    'renders the canonical support address with caller value %s',
    supportEmail => {
      const html = renderTemplate('codeReviewDisabled', {
        reason: 'Repository access requires attention.',
        recovery_url: 'https://app.example/code-reviews',
        recovery_label: 'Open Code Reviewer',
        year: '2026',
        ...(supportEmail ? { support_email: supportEmail } : {}),
      });

      expect(html).toContain('reply to this email or contact hi@kilo.ai.');
      expect(html).not.toContain('other@example.com');
      expect(html).not.toMatch(/\{\{/);
    }
  );

  it('reports an unreadable template to Sentry and rethrows', () => {
    expect(() => renderTemplate('doesNotExist', {})).toThrow(/ENOENT/);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ENOENT' }),
      expect.objectContaining({
        tags: { source: 'email_template', email_template: 'doesNotExist' },
      })
    );
  });
});

describe('support email defaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends account deletion notifications to support with the user as Reply-To', async () => {
    await sendAccountDeletionSupportNotification('user@example.com', 'user-1');

    expect(sendViaMailgun).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'hi@kilo.ai',
        replyTo: 'user@example.com',
        category: 'accountDeletionSupport',
      })
    );
  });

  it.each([
    [undefined, 'mailto:hi@kilo.ai'],
    ['https://support.example/help', 'https://support.example/help'],
  ])(
    'renders the duplicate-card support link with override %s',
    async (supportUrl, expectedUrl) => {
      await sendKiloPassDuplicateCardCanceledEmail('user@example.com', { supportUrl });

      expect(sendViaMailgun).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'kiloPassDuplicateCardCanceled',
          html: expect.stringContaining(`href="${expectedUrl}"`),
        })
      );
    }
  );
});

describe('store credit web tip rendering', () => {
  it('escapes link variables without consuming the provider unsubscribe substitution', () => {
    const html = renderTemplate(
      'storeCreditWebTip',
      {
        credits_url: 'https://app.example/credits?account="><img src=x onerror=alert(1)>&other=1',
        year: '2026',
      },
      'marketing-emails'
    );

    expect(html).toContain(
      'href="https://app.example/credits?account=&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;other=1"'
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('href="%tag_unsubscribe_url%"');
    expect(html).not.toMatch(/\{\{\s*\w+\s*\}\}/);
  });
});

describe('user data export ready email', () => {
  it('uses the required subject and only links to the authenticated export page', () => {
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

describe('account deletion completed email', () => {
  it('uses the canonical completion copy and transactional footer', async () => {
    const html = renderTemplate('accountDeletionCompleted', {
      completion_message: new RawHtml(USER_DELETION_COMPLETION_HTML),
      year: '2026',
    });

    expect(html).toContain('permanently deleted and anonymized');
    expect(html).toContain('contact Kilo support immediately');
    expect(html).toContain('Kilo Code, Inc');
    expect(html).not.toContain('case management');
    expect(html).not.toContain('1–2 business days');

    await expect(sendAccountDeletionCompletedEmail('user@example.com')).resolves.toEqual({
      sent: true,
    });
    expect(sendViaMailgun).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: subjects.accountDeletionCompleted,
        category: 'accountDeletionCompleted',
        html: expect.stringContaining(USER_DELETION_COMPLETION_HTML),
      })
    );
  });
});

describe('spend alert email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('carries this scope amount and threshold and exactly one call to action', async () => {
    await sendSpendAlertEmail({
      to: ['billing@example.com'],
      scopeType: 'organization',
      scopeId: 'org-1',
      scopeName: 'Acme',
      kindLabel: 'Spend threshold',
      amountUsd: 12.5,
      thresholdUsd: 10,
    });

    expect(sendViaMailgun).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'billing@example.com',
        subject: subjects.spendAlert,
        category: 'spendAlert',
      })
    );
    const { html } = jest.mocked(sendViaMailgun).mock.calls[0][0];

    expect(html).toContain('Acme');
    expect(html).toContain('12.50');
    expect(html).toContain('10.00');
    expect(html).toContain(`${NEXTAUTH_URL}/organizations/org-1/usage-details`);
    // The alert has a single call to action: the scope's spend view.
    expect((html.match(/href=/g) ?? []).length).toBe(1);
  });

  it('links a personal scope to the personal spend view', async () => {
    await sendSpendAlertEmail({
      to: ['owner@example.com'],
      scopeType: 'personal',
      scopeId: 'user-1',
      scopeName: 'Your account',
      kindLabel: 'Hourly spike',
      amountUsd: 5,
      thresholdUsd: 4,
    });

    const { html } = jest.mocked(sendViaMailgun).mock.calls[0][0];
    expect(html).toContain(`${NEXTAUTH_URL}/usage`);
    expect(html).not.toContain('/organizations/');
  });

  it('reports an accepted recipient as delivered', async () => {
    await expect(
      sendSpendAlertEmail({
        to: ['billing@example.com'],
        scopeType: 'organization',
        scopeId: 'org-1',
        scopeName: 'Acme',
        kindLabel: 'Spend threshold',
        amountUsd: 12.5,
        thresholdUsd: 10,
      })
    ).resolves.toEqual({
      delivered: ['billing@example.com'],
      retryable: [],
      undeliverable: [],
    });
  });

  it('classifies an unconfigured provider as undeliverable, not retryable', async () => {
    jest.mocked(sendViaMailgun).mockResolvedValueOnce(false);

    const outcome = await sendSpendAlertEmail({
      to: ['billing@example.com'],
      scopeType: 'organization',
      scopeId: 'org-1',
      scopeName: 'Acme',
      kindLabel: 'Spend threshold',
      amountUsd: 12.5,
      thresholdUsd: 10,
    });

    expect(outcome).toEqual({
      delivered: [],
      retryable: [],
      undeliverable: ['billing@example.com'],
    });
  });

  it('classifies a thrown transport error as retryable', async () => {
    jest.mocked(sendViaMailgun).mockRejectedValueOnce(new Error('socket hang up'));

    const outcome = await sendSpendAlertEmail({
      to: ['billing@example.com'],
      scopeType: 'organization',
      scopeId: 'org-1',
      scopeName: 'Acme',
      kindLabel: 'Spend threshold',
      amountUsd: 12.5,
      thresholdUsd: 10,
    });

    expect(outcome).toEqual({
      delivered: [],
      retryable: ['billing@example.com'],
      undeliverable: [],
    });
  });
});
