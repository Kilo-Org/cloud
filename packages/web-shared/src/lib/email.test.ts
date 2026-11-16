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
  buildCreditsSection,
  buildCreditsTopUpCreditsRowSection,
  buildCreditsTopUpExpirySection,
  buildCreditsTopUpInfoRow,
  buildCreditsTopUpReceiptSection,
  buildCreditsTopUpServiceFeeSection,
} from '@kilocode/web-shared/lib/email';
import fs from 'fs';
import path from 'path';
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

// ---------------------------------------------------------------------------
// Dark mode: every inline palette declaration maps to a kc-* class so the
// stylesheet injected by renderTemplate can override it in dark mode.
// ---------------------------------------------------------------------------

const EMAILS_DIR = path.join(process.cwd(), '..', '..', 'packages', 'web-shared', 'src', 'emails');

type ClassRule = { className: string; declarations: RegExp };

const CLASS_RULES: ClassRule[] = [
  { className: 'kc-page', declarations: /background(?:-color)?:\s*#(?:ffffff|fff)\b/i },
  { className: 'kc-strong', declarations: /(?:^|;)\s*color:\s*#1a1a1a\b/i },
  { className: 'kc-text', declarations: /(?:^|;)\s*color:\s*#333\b/i },
  { className: 'kc-muted', declarations: /(?:^|;)\s*color:\s*#555\b/i },
  { className: 'kc-faint', declarations: /(?:^|;)\s*color:\s*#ccc\b/i },
  {
    className: 'kc-box',
    declarations: /(?:background-color:\s*#f6f6f4\b|border:\s*1px solid #ebebea\b)/i,
  },
  { className: 'kc-divider', declarations: /border-top:\s*1px solid #(?:ebebea|eee)\b/i },
  { className: 'kc-btn', declarations: /background(?:-color)?:\s*#1a1a1a\b/i },
];

function readAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[1] ?? match[2]) : undefined;
}

// Returns one actionable line per violation: file, tag, declaration, class.
function findClassViolations(html: string, source: string): string[] {
  const violations: string[] = [];
  for (const match of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = match[0];
    const style = readAttribute(tag, 'style');
    if (!style) continue;
    const normalized = style.replace(/\s+/g, ' ').trim();
    const classes = new Set((readAttribute(tag, 'class') ?? '').split(/\s+/).filter(Boolean));
    for (const rule of CLASS_RULES) {
      const declaration = normalized.match(rule.declarations)?.[0];
      // background-color: #1a1a1a is the CTA surface, not strong text.
      if (
        rule.className === 'kc-strong' &&
        /background(?:-color)?:\s*#1a1a1a\b/i.test(normalized)
      ) {
        continue;
      }
      if (!declaration || classes.has(rule.className)) continue;
      violations.push(
        `${source}: ${tag.slice(0, 160)} → "${declaration}" needs class="${rule.className}"`
      );
    }
  }
  return violations;
}

function dummyTemplateVars(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of raw.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    vars[match[1]] = 'Sample value';
  }
  return vars;
}

describe('dark mode support', () => {
  const templateFiles = fs
    .readdirSync(EMAILS_DIR)
    .filter(file => file.endsWith('.html'))
    .sort();

  it('finds the transactional templates', () => {
    expect(templateFiles.length).toBeGreaterThan(40);
  });

  it.each(templateFiles)('%s declares dark mode and classes its palette', file => {
    const name = file.replace(/\.html$/, '');
    const raw = fs.readFileSync(path.join(EMAILS_DIR, file), 'utf-8');
    const html = renderTemplate(name, dummyTemplateVars(raw));

    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
    expect(html).toContain('prefers-color-scheme: dark');
    if (head !== undefined) {
      expect(head).toContain('prefers-color-scheme: dark');
      expect(head).toContain('name="color-scheme" content="light dark"');
    }
    const bodyIndex = html.search(/<body\b/i);
    if (bodyIndex !== -1) {
      expect(html.indexOf('prefers-color-scheme: dark')).toBeLessThan(bodyIndex);
    }

    // Proton Mail iOS leaves explicit white surfaces white while lightening
    // text; page backgrounds must stay unset so the client's own shows through.
    expect(html).not.toMatch(/background(?:-color)?:\s*#(?:ffffff|fff)\b/i);

    const bodies = [...html.matchAll(/<body\b[^>]*>/gi)].map(match => match[0]);
    if (bodies.length === 0) {
      // Bare fragment templates (e.g. securityFinding*) carry kc-page on their
      // outer table instead of a body element. The injected stylesheet also
      // mentions .kc-page, so inspect the root table tag rather than the text.
      const rootTable = html.match(/<table\b[^>]*>/i)?.[0] ?? '';
      expect(rootTable).not.toBe('');
      expect(readAttribute(rootTable, 'class') ?? '').toContain('kc-page');
    }
    for (const body of bodies) {
      expect(readAttribute(body, 'class') ?? '').toContain('kc-page');
    }

    expect(findClassViolations(html, file)).toEqual([]);
  });

  it('classes the inline-styled fragment builders', () => {
    const fragments: Record<string, string> = {
      buildCreditsSection: buildCreditsSection(10).html,
      buildCreditsTopUpInfoRow: buildCreditsTopUpInfoRow('Label', '$10.00 USD'),
      buildCreditsTopUpReceiptSection: buildCreditsTopUpReceiptSection(
        'https://billing.example/receipt'
      ).html,
      buildCreditsTopUpServiceFeeSection: buildCreditsTopUpServiceFeeSection({
        serviceFeeCents: 100,
        grossPaidCents: 2100,
      }).html,
      buildCreditsTopUpCreditsRowSection: buildCreditsTopUpCreditsRowSection({
        creditsCents: 2000,
        hasServiceFee: false,
      }).html,
      buildCreditsTopUpExpirySection: buildCreditsTopUpExpirySection(
        new Date('2027-01-02T00:00:00.000Z')
      ).html,
    };

    expect(buildCreditsSection(0).html).toBe('');
    for (const [builder, html] of Object.entries(fragments)) {
      expect(html).not.toBe('');
      expect(findClassViolations(html, builder)).toEqual([]);
    }
  });

  it('leaves marketing templates without the dark mode block', () => {
    const html = renderTemplate(
      'storeCreditWebTip',
      { credits_url: 'https://app.example/credits', year: '2026' },
      'marketing-emails'
    );

    expect(html).not.toContain('prefers-color-scheme: dark');
    expect(html).not.toContain('color-scheme');
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
