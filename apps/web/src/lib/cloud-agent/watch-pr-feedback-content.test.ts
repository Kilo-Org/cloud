import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { appendPreviousReviewSummaryHistory } from '@/lib/code-reviews/summary/history';
import { appendReviewSummaryFooter } from '@/lib/code-reviews/summary/usage-footer';
import { watchPrContentFingerprint, watchPrFeedbackContent } from './watch-pr-feedback-content';
import {
  emptyWatchPrProjection,
  normalizeWatchPrEvent,
  projectWatchPrEvent,
  type WatchPrObservationState,
} from './watch-pr-events';
const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
function summary(
  finding = 'Handle the empty list.',
  status = '1 Issue Found',
  commit = 'c'.repeat(40)
) {
  return `<!-- kilo-review -->\n## Code Review Summary\n\n**Status:** ${status} | **Recommendation:** Address before merge\n\n### Findings\n${finding}\n\n## Fix Link\n[Fix findings](https://example.test/fix/${commit})`;
}
function event(body: string, updated_at = '2026-11-12T12:00:00Z') {
  const normalized = normalizeWatchPrEvent('issue_comment', {
    installation: { id: 123 },
    repository: { id: 456 },
    action: 'edited',
    issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/test/repo/pulls/7' } },
    comment: {
      id: 9,
      body,
      user: { id: 8, login: 'kiloconnect-lite[bot]', type: 'Bot' },
      author_association: 'NONE',
      updated_at,
    },
  });
  if (!normalized) throw new Error('Missing event');
  return normalized;
}
function watch(): WatchPrObservationState {
  return {
    installation_id: '123',
    repository_id: '456',
    pr_number: 7,
    head_ref: 'feature',
    base_ref: 'main',
    head_sha: head,
    base_sha: base,
    status: 'watching',
    generation: 1,
    pending_revision: 0,
    projection: emptyWatchPrProjection(),
    lifecycle_reason: null,
    policy,
  };
}
describe('Kilo review actionable content', () => {
  it('handles long delimiter runs without dropping actionable content', () => {
    for (const body of ['`'.repeat(65_536), '<!--'.repeat(250_000)]) {
      expect(watchPrFeedbackContent(body, 'trusted-reviewer')).toBe(body);
      expect(watchPrContentFingerprint(body)).not.toBe(watchPrContentFingerprint(`${body}fix`));
    }
  });
  it('ignores comment content, including code delimiters, but preserves code literals', () => {
    expect(watchPrContentFingerprint('fix <!-- `old` --> now')).toBe(
      watchPrContentFingerprint('fix now')
    );
    expect(watchPrContentFingerprint('fix `<!-- literal -->`')).not.toBe(
      watchPrContentFingerprint('fix ``')
    );
  });
  it.each([
    'thanks',
    'Thanks!',
    'Thanks! <!-- review metadata -->',
    '@reviewer done.',
    'LGTM',
    'Looks good to me.',
    '👍',
    'CI is running',
    'All checks have passed.',
  ])('does not turn a clear acknowledgement or status into a repair: %s', body => {
    expect(watchPrFeedbackContent(body, 'trusted-reviewer')).toBe('');
  });
  it.each([
    'Thanks, but please handle the empty list.',
    'done?',
    'Please confirm CI permissions.',
    'CI failed',
    'This might be wrong',
    '`done`',
  ])('retains unknown or actionable content for agent judgment: %s', body => {
    expect(watchPrFeedbackContent(body, 'trusted-reviewer')).toBe(body);
  });
  it.each(['kiloconnect[bot]', 'kiloconnect-lite[bot]', 'kiloconnect-development[bot]'])(
    'keeps actual %s findings but ignores usage, history, status, and Fix Link changes',
    author => {
      const original = appendReviewSummaryFooter(
        appendPreviousReviewSummaryHistory(summary(), summary('Old request.'), 'd'.repeat(40)),
        { usage: { model: 'test/old', tokensIn: 100, tokensOut: 20, cachedTokens: 0 } }
      );
      const edited = appendReviewSummaryFooter(
        appendPreviousReviewSummaryHistory(
          summary(undefined, '2 Issues Found', 'e'.repeat(40)),
          summary('Different old request.'),
          'f'.repeat(40)
        ),
        {
          usage: { model: 'test/new', tokensIn: 200, tokensOut: 40, cachedTokens: 20 },
          reviewGuidance: { used: true, ref: 'main', truncated: false },
        }
      );
      const before = watchPrFeedbackContent(original, author),
        after = watchPrFeedbackContent(edited, author);
      expect(before).toContain('Handle the empty list.');
      expect(before).not.toContain('Old request');
      expect(before).not.toContain('Fix findings');
      expect(watchPrContentFingerprint(before)).toBe(watchPrContentFingerprint(after));
      expect(
        watchPrContentFingerprint(
          watchPrFeedbackContent(summary('Handle a missing list too.'), author)
        )
      ).not.toBe(watchPrContentFingerprint(before));
    }
  );
  it('does not start a second batch for an in-place summary metadata edit', () => {
    const first = projectWatchPrEvent(watch(), event(summary()), 1);
    const body = appendReviewSummaryFooter(
      appendPreviousReviewSummaryHistory(
        summary(undefined, '2 Issues Found', 'e'.repeat(40)),
        summary('Old findings.'),
        'f'.repeat(40)
      ),
      { usage: { model: 'test/new', tokensIn: 200, tokensOut: 40, cachedTokens: 20 } }
    );
    const edited = projectWatchPrEvent(first, event(body, '2026-11-12T12:01:00Z'), 1);
    expect(edited.pending_revision).toBe(first.pending_revision);
  });
  it('removes resolved summary work instead of treating a clean review as a new code request', () => {
    const first = projectWatchPrEvent(watch(), event(summary()), 1);
    const clean = projectWatchPrEvent(
      first,
      event(summary('Ready to merge.', 'No Issues Found'), '2026-11-12T12:01:00Z'),
      1
    );
    expect(clean.projection).toMatchObject({ pending: [] });
    expect(watchPrFeedbackContent(summary(undefined, 'No New Issues'), 'kiloconnect[bot]')).toBe(
      ''
    );
  });
  it('keeps current findings small even when appended old history exceeds the brief limit', () => {
    const body = appendPreviousReviewSummaryHistory(
      summary(),
      summary('old '.repeat(6000)),
      'c'.repeat(40)
    );
    expect(body.length).toBeGreaterThan(12000);
    expect(event(body)).toMatchObject({
      bodyTruncated: false,
      body: expect.stringContaining('Handle the empty list.'),
    });
  });
  it('does not convert a reviewer infrastructure notice into a code repair', () => {
    expect(
      watchPrFeedbackContent(
        '<!-- kilo-review -->\n## Code Review Summary\n\n**This review did not finish.** The provider rejected the request.',
        'kiloconnect[bot]'
      )
    ).toBe('');
  });
  it('does not blanket-ignore inline bot findings or human-authored marker text', () => {
    expect(watchPrFeedbackContent('Handle the empty list.', 'kiloconnect[bot]')).toBe(
      'Handle the empty list.'
    );
    expect(watchPrFeedbackContent(summary(), 'human-reviewer')).toBe(summary());
  });
  it('preserves status and Fix Link literals inside actionable code examples', () => {
    const body = summary(
      'Preserve this literal:\n```md\n**Status:** No Issues Found\n## Fix Link\nkeep this code\n```'
    );
    const content = watchPrFeedbackContent(body, 'kiloconnect[bot]');
    expect(content).toContain('**Status:** No Issues Found');
    expect(content).toContain('## Fix Link\nkeep this code');
    expect(content).not.toContain('Fix findings');
    expect(watchPrContentFingerprint(content)).not.toBe(
      watchPrContentFingerprint(
        watchPrFeedbackContent(
          body.replace('keep this code', 'keep different code'),
          'kiloconnect[bot]'
        )
      )
    );
  });
});
