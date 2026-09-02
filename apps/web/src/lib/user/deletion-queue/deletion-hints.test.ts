import {
  deletionAttentionHint,
  deletionManualSearchHref,
} from '@/lib/user/deletion-queue/deletion-hints';

describe('deletionManualSearchHref', () => {
  it('preserves exact opaque user IDs in PostHog search links', () => {
    expect(
      deletionManualSearchHref({
        stepKey: 'posthog',
        userId: 'oauth/GitHub/Opaque ID+42',
        email: 'ignored@example.com',
      })
    ).toEqual({
      href: 'https://us.posthog.com/persons?search=oauth%2FGitHub%2FOpaque%20ID%2B42',
      label: 'Open PostHog persons',
    });
  });

  it.each([
    ['posthog', 'https://us.posthog.com/persons?search=customer%40example.com'],
    ['substack', 'https://kilocode.substack.com/publish/subscribers?s=customer%40example.com'],
  ])('retains email normalization for ordinary %s searches', (stepKey, href) => {
    expect(deletionManualSearchHref({ stepKey, email: ' Customer@Example.com ' })?.href).toBe(href);
  });

  it('leaves the PostHog search unfiltered when a user ID was scrubbed', () => {
    expect(deletionManualSearchHref({ stepKey: 'posthog', userId: null })?.href).toBe(
      'https://us.posthog.com/persons'
    );
  });
});

describe('deletionAttentionHint', () => {
  it('returns operator copy for known codes', () => {
    expect(deletionAttentionHint('protected_self')).toEqual({
      title: 'You cannot delete your own account',
      action: 'Ask another admin to submit this request.',
    });
    expect(deletionAttentionHint('credential_expired')).toEqual({
      title: 'Substack credential expired',
      action: 'Replace the Substack session credential, then Retry.',
    });
    expect(deletionAttentionHint('http_404')?.title).toBe('Provider returned HTTP 404');
    expect(deletionAttentionHint('posthog_ambiguous')?.action).toMatch(/Mark done/);
    expect(deletionAttentionHint('already_active')?.title).toMatch(/already in the queue/);
    expect(deletionAttentionHint('usage_prefix_progress_invalid')?.action).not.toMatch(/Mark done/);
    expect(deletionAttentionHint('delete_ready_missing')?.action).toMatch(/delete-ready/);
    expect(deletionAttentionHint('csa_unauthorized')?.title).toMatch(/CSA/);
    expect(deletionAttentionHint('csa_unauthorized')?.action).toMatch(
      /CSA_VERCEL_PROTECTION_BYPASS/
    );
    expect(deletionAttentionHint('completion_email_unavailable')).toEqual({
      title: 'Completion email provider is not configured',
      action: 'Repair the Mailgun configuration, then use Retry to send the completion email.',
    });
    expect(deletionAttentionHint('completion_email_rejected')?.action).toMatch(/Mark done/);
    expect(deletionAttentionHint('completion_email_ambiguous')?.action).toMatch(
      /without resending/
    );
  });

  it('falls back for other HTTP statuses', () => {
    expect(deletionAttentionHint('http_401')).toEqual({
      title: 'Provider returned HTTP 401',
      action:
        'Open the provider, confirm the resource, then Retry. If the provider UI shows the work is already done, Mark done with evidence.',
    });
    expect(deletionAttentionHint('http_503')).toMatchObject({
      title: 'Provider returned HTTP 503',
    });
  });

  it('humanizes unknown codes and returns null for empty input', () => {
    expect(deletionAttentionHint(null)).toBeNull();
    expect(deletionAttentionHint(undefined)).toBeNull();
    expect(deletionAttentionHint('')).toBeNull();
    expect(deletionAttentionHint('totally_new_code')).toEqual({
      title: 'Totally new code',
      action:
        'Retry after fixing the cause, or Mark done if you completed this task outside the queue.',
    });
  });
});
