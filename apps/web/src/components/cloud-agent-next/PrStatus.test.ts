import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrBadge } from './PrBadge';
import { PrHoverCardContent } from './PrHoverCardContent';
import { SessionPrIndicator } from './SessionPrIndicator';
import type { AssociatedPr } from './utils/github-pr-link';

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cliSessionsV2: { refreshAssociatedPullRequest: { mutationOptions: () => ({}) } },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
}));

const pr: AssociatedPr = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  state: 'open',
  title: 'Update checks',
  headSha: 'a'.repeat(40),
  lastSyncedAt: '2026-10-21T12:00:00Z',
  reviewDecision: 'approved',
  reviewDecisionPending: false,
  platform: 'github',
  observations: { checks: { total: 8, failed: 2 }, unresolvedThreads: 3, truncated: false },
};
function hoverCard(value = pr) {
  return renderToStaticMarkup(
    createElement(PrHoverCardContent, { pr: value, sessionId: 'session', gitBranch: 'feature' })
  );
}
describe('passive PR status', () => {
  it('shows compact observed counts without watch controls', () => {
    const html = hoverCard();
    expect(html).toContain('8 total / 2 failed');
    expect(html).toContain('Unresolved threads');
    expect(html).toContain('>3</span>');
    expect(html).not.toContain('Watch PR');
    expect(html).not.toContain('Pause');
    expect(html).not.toContain('Saved preferences');
  });
  it('does not present missing observations as zero', () => {
    const html = hoverCard({ ...pr, observations: null });
    expect(html.match(/>Unknown</g)).toHaveLength(2);
    expect(html).not.toContain('0 total');
  });
  it('distinguishes observed zero unresolved threads from unknown', () => {
    expect(
      hoverCard({ ...pr, observations: { checks: null, unresolvedThreads: 0, truncated: false } })
    ).toContain('>0</span>');
  });
  it('marks bounded observations as partial', () => {
    expect(
      hoverCard({
        ...pr,
        observations: { checks: { total: 8, failed: 2 }, unresolvedThreads: 3, truncated: true },
      })
    ).toContain('8+ total / 2+ failed');
  });
  it('does not change badge color for failures whose requiredness is unknown', () => {
    const badge = (value: AssociatedPr) =>
      renderToStaticMarkup(createElement(PrBadge, { pr: value }));
    expect(badge(pr)).toBe(badge({ ...pr, observations: null }));
  });
  it('does not add GitHub observations to other platforms', () => {
    expect(hoverCard({ ...pr, platform: 'gitlab' })).not.toContain('Checks (observed)');
  });
  it('renders just the existing badge without an opt-in eye button', () => {
    const html = renderToStaticMarkup(
      createElement(SessionPrIndicator, {
        session: {
          sessionId: 'session',
          branch: 'feature',
          repository: 'owner/repo',
          associatedPr: pr,
        },
      })
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('Watch PR');
  });
});
