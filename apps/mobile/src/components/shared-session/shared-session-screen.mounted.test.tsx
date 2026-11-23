// The shared session header always names the session on its eyebrow line: the
// repository when the payload has one, and otherwise the time the session
// started, so a link without a repository never centres a title over a line it
// dropped. That time is the payload's `createdAt`, never a snapshot time, so
// the copy says the session started. Only a read that is still running paints
// the placeholder bar; a failed read and a payload with no usable timestamp
// keep the reserved line blank.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { act, TestRenderer } from '@/test/renderer';

import { SharedSessionScreen } from './shared-session-screen';

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isPending: false,
  isError: false,
  isFetching: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

type HeaderProps = {
  eyebrow?: string;
  reserveEyebrow?: boolean;
  eyebrowPlaceholder?: unknown;
  subtitle?: string;
};

const headers = vi.hoisted(() => ({
  rendered: [] as HeaderProps[],
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  View: 'View',
}));
vi.mock('@/components/agents/session-preview-transcript', () => ({
  SessionPreviewTranscript: 'SessionPreviewTranscript',
}));
// The `owner/repo` pin is covered by its own suite; here it only has to reach
// the eyebrow line.
vi.mock('@kilocode/app-shared/git-url-project', () => ({
  formatGitUrlProject: (gitUrl: string) => gitUrl,
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: HeaderProps) => {
    headers.rendered.push(props);
    return null;
  },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      getSharedSession: {
        queryOptions: () => ({ queryKey: ['cliSessionsV2.getSharedSession'] }),
      },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => query,
}));

const CREATED_AT = '2026-11-17T15:52:00.000Z';

const ISOLATE_OPEN = '\u2068';
const ISOLATE_CLOSE = '\u2069';

// The subtitle wraps each segment in the first-strong isolate pair itself, so
// the expected line spells the marks out rather than reusing the helper.
function isolated(text: string): string {
  return `${ISOLATE_OPEN}${text}${ISOLATE_CLOSE}`;
}

function sharedByLabel(ownerName: string): string {
  // The screen isolates the interpolated owner inside the sentence, so a
  // catalog that puts the placeholder first keeps the sentence's direction.
  return i18n.t('sharedSession.sharedBy', { owner: isolated(ownerName) });
}

function sharedSession(metadata: Record<string, unknown>): Record<string, unknown> {
  return { metadata, messages: [], transcriptUnavailable: false };
}

/** A payload that names a repository, which most of these cases watch. */
function repoSession(gitBranch: string | null, createdAt: string | null = CREATED_AT) {
  return sharedSession({
    title: 'Fix login',
    ownerName: 'alice',
    gitUrl: 'Kilo-Org/cloud',
    gitBranch,
    createdAt,
  });
}

/** A payload with no repository, so the eyebrow falls back to the start time. */
function repoLessSession(createdAt: string | null = CREATED_AT) {
  return sharedSession({
    title: 'Fix login',
    ownerName: 'alice',
    gitUrl: null,
    gitBranch: null,
    createdAt,
  });
}

function renderScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SharedSessionScreen, { shareToken: 'share-token' })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function startedAtLabel(createdAt: string): string {
  return i18n.t('sharedSession.startedAt', {
    time: formatDate(new Date(createdAt), i18n.language, { timeStyle: 'short' }),
  });
}

// The date the subtitle prints for the same payload timestamp, in the language
// the screen formats with. The screen adds the year to a session from an
// earlier year and leaves it off one from the current year, comparing the
// years the locale itself prints, so the expectation reads the same clock and
// calendar.
function subtitleDateLabel(createdAt: string): string {
  const date = new Date(createdAt);
  const currentYear = formatDate(new Date(), i18n.language, { year: 'numeric' });
  const sessionYear = formatDate(date, i18n.language, { year: 'numeric' });
  return formatDate(date, i18n.language, {
    month: 'short',
    day: 'numeric',
    ...(sessionYear === currentYear ? {} : { year: 'numeric' }),
  });
}

// A fixed clock keeps both the current-year and the prior-year expectation
// deterministic: the payload year is compared with the reader's own year.
const NOW = new Date('2026-11-22T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  query.data = undefined;
  query.isPending = false;
  query.isError = false;
  query.isFetching = false;
  query.error = null;
  query.refetch.mockClear();
  headers.rendered = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shared session header eyebrow', () => {
  it('paints the repository when the payload has one', () => {
    query.data = repoSession('main');
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.eyebrow).toBe('Kilo-Org/cloud');
    expect(headers.rendered[0]?.reserveEyebrow).toBe(false);
    renderer.unmount();
  });

  it('names the session time when the payload has no repository', () => {
    query.data = repoLessSession();
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    // The payload carries the session's creation time, not the share time, so
    // the line says the session started then instead of claiming a snapshot.
    expect(headers.rendered[0]?.eyebrow).toBe(startedAtLabel(CREATED_AT));
    expect(headers.rendered[0]?.reserveEyebrow).toBe(false);
    renderer.unmount();
  });

  it('reserves the line while the read runs', () => {
    query.isPending = true;
    const renderer = renderScreen();

    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeTruthy();
    renderer.unmount();
  });

  it('keeps the reserved line when the read fails', () => {
    query.isError = true;
    query.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = renderScreen();

    // The line stays reserved so the title holds its place, but nothing paints
    // over it: the failed read is not loading, so the bar would pulse forever.
    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeUndefined();
    renderer.unmount();
  });

  it('keeps the reserved line when the payload has no usable timestamp', () => {
    query.data = repoLessSession(null);
    const renderer = renderScreen();

    // A settled payload that names neither a repository nor a time is not a
    // pending read, so the line holds blank instead of loading.
    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeUndefined();
    renderer.unmount();
  });
});

describe('shared session subtitle', () => {
  it('shows the decoded branch, not the stored percent-encoded one', () => {
    query.data = repoSession('fix/%E8%AB%8B%E6%B1%82%E6%9B%B8');
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.subtitle).toContain('fix/請求書');
    expect(headers.rendered[0]?.subtitle).not.toContain('%E8%AB%8B');
    renderer.unmount();
  });

  it('isolates the sharer, the branch and the date so a right-to-left date cannot split', () => {
    query.data = repoSession('fix/%E8%AB%8B%E6%B1%82%E6%9B%B8');
    const renderer = renderScreen();

    // Every segment carries its own isolate pair, so the paragraph direction
    // cannot move the date's day number next to the sharer or its month past
    // the branch: the three segments stay sharer, branch, date.
    const expected = [
      isolated(sharedByLabel('alice')),
      isolated('fix/請求書'),
      isolated(subtitleDateLabel(CREATED_AT)),
    ].join(' · ');
    expect(headers.rendered[0]?.subtitle).toBe(expected);
    renderer.unmount();
  });

  it('leaves no empty isolate pair when the payload has no branch', () => {
    query.data = repoSession(null);
    const renderer = renderScreen();

    const subtitle = headers.rendered[0]?.subtitle ?? '';
    // The dropped branch leaves two segments and no pair of marks with nothing
    // between them: each of the two carries its own outer pair, and the sharer's
    // inner pair holds the interpolated owner.
    expect(subtitle).toBe(
      [isolated(sharedByLabel('alice')), isolated(subtitleDateLabel(CREATED_AT))].join(' · ')
    );
    const segments = subtitle.split(' · ');
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.startsWith(ISOLATE_OPEN)).toBe(true);
      expect(segment.endsWith(ISOLATE_CLOSE)).toBe(true);
    }
    renderer.unmount();
  });

  it('shows the year when the session started before the current calendar year', () => {
    const priorYear = '2025-10-08T19:40:00.000Z';
    query.data = repoSession('main', priorYear);
    const renderer = renderScreen();

    // A permanent share outlives its year, so a month and a day alone would
    // read it as this year's date. The last segment carries the year.
    const dateLabel = subtitleDateLabel(priorYear);
    expect(dateLabel).toContain('2025');
    expect(headers.rendered[0]?.subtitle).toBe(
      [isolated(sharedByLabel('alice')), isolated('main'), isolated(dateLabel)].join(' · ')
    );
    renderer.unmount();
  });

  it('keeps the short date for a session from the current calendar year', () => {
    query.data = repoSession('main');
    const renderer = renderScreen();

    // The clock is pinned inside the current calendar year, so this date does
    // not need the year it would repeat.
    const dateLabel = subtitleDateLabel(CREATED_AT);
    expect(dateLabel).not.toContain('2026');
    expect(headers.rendered[0]?.subtitle).toBe(
      [isolated(sharedByLabel('alice')), isolated('main'), isolated(dateLabel)].join(' · ')
    );
    renderer.unmount();
  });
});
