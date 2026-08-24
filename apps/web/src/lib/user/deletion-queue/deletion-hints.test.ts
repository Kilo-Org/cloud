import { deletionAttentionHint } from '@/lib/user/deletion-queue/deletion-hints';

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
