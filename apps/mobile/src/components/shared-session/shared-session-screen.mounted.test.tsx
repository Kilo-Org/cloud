// The shared session header always names the session on its eyebrow line: the
// repository when the payload has one, and otherwise the time the session was
// created, so a link without a repository never centres a title over a line it
// dropped. A read that is still running, a read that failed, and a payload with
// no usable timestamp all keep the reserved line with its placeholder bar.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/components/agents/session-list-helpers', () => ({
  formatGitUrlProject: (gitUrl: string) => gitUrl,
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/eyebrow-placeholder', () => ({
  EyebrowPlaceholder: 'EyebrowPlaceholder',
}));
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

function sharedSession(metadata: Record<string, unknown>): Record<string, unknown> {
  return { metadata, messages: [], transcriptUnavailable: false };
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

function asOfLabel(createdAt: string): string {
  return i18n.t('agentChat.sessionChanges.asOf', {
    time: formatDate(new Date(createdAt), i18n.language, { timeStyle: 'short' }),
  });
}

beforeEach(() => {
  query.data = undefined;
  query.isPending = false;
  query.isError = false;
  query.isFetching = false;
  query.error = null;
  query.refetch.mockClear();
  headers.rendered = [];
});

describe('shared session header eyebrow', () => {
  it('paints the repository when the payload has one', () => {
    query.data = sharedSession({
      title: 'Fix login',
      ownerName: 'alice',
      gitUrl: 'Kilo-Org/cloud',
      gitBranch: 'main',
      createdAt: CREATED_AT,
    });
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.eyebrow).toBe('Kilo-Org/cloud');
    expect(headers.rendered[0]?.reserveEyebrow).toBe(false);
    renderer.unmount();
  });

  it('names the session time when the payload has no repository', () => {
    query.data = sharedSession({
      title: 'Fix login',
      ownerName: 'alice',
      gitUrl: null,
      gitBranch: null,
      createdAt: CREATED_AT,
    });
    const renderer = renderScreen();

    expect(headers.rendered).toHaveLength(1);
    expect(headers.rendered[0]?.eyebrow).toBe(asOfLabel(CREATED_AT));
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

    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeTruthy();
    renderer.unmount();
  });

  it('keeps the reserved line when the payload has no usable timestamp', () => {
    query.data = sharedSession({
      title: 'Fix login',
      ownerName: 'alice',
      gitUrl: null,
      gitBranch: null,
      createdAt: null,
    });
    const renderer = renderScreen();

    expect(headers.rendered[0]?.eyebrow).toBeUndefined();
    expect(headers.rendered[0]?.reserveEyebrow).toBe(true);
    expect(headers.rendered[0]?.eyebrowPlaceholder).toBeTruthy();
    renderer.unmount();
  });
});
