import { act, TestRenderer } from '@/test/renderer';
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { SessionShareSection } from './session-share-section';

/** What the section's `cliSessionsV2.get` read returns; every case replaces it. */
type ShareQueryState = {
  data?: { public_id?: string | null };
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<void>;
};

type ShareHandler = (created: { share_token: string }) => Promise<void> | void;

/** What the section asks the share mutation to create. */
type ShareInput = {
  session_id: string;
  duration: string;
  include_new_messages: boolean;
};

const holder = vi.hoisted(
  (): {
    queryState: ShareQueryState;
    shareSuccess: ShareHandler | null;
    unshareSuccess: (() => void) | null;
    lastShareInput: ShareInput | null;
  } => ({
    queryState: {
      data: undefined,
      isPending: true,
      isError: false,
      isFetching: false,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve(),
    },
    shareSuccess: null,
    unshareSuccess: null,
    lastShareInput: null,
  })
);

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => holder.queryState,
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  useMutation: (options: {
    share?: boolean;
    onSuccess?: (created: { share_token: string }) => Promise<void> | void;
    unshare?: boolean;
  }) => {
    if (options.share) {
      holder.shareSuccess = options.onSuccess ?? null;
      return {
        mutate: (input: ShareInput) => {
          holder.lastShareInput = input;
        },
        isPending: false,
      };
    }
    holder.unshareSuccess = options.onSuccess as never;
    return { mutate: () => undefined, isPending: false };
  },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      get: { queryOptions: () => ({}), queryKey: () => ['get'] },
      share: { mutationOptions: () => ({ share: true }) },
      unshare: { mutationOptions: () => ({ unshare: true }) },
    },
  }),
}));
vi.mock('@/lib/haptics', () => ({
  notificationHaptic: vi.fn(),
}));
vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'http://localhost:3000',
}));
vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => i18n.t(key) }),
  };
});

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function renderSection(visible = true): Renderer {
  const ref: { current: Renderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionShareSection, { sessionId: 'ses-123', visible })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function rerenderSection(renderer: Renderer, visible = true): void {
  act(() => {
    renderer.update(createElement(SessionShareSection, { sessionId: 'ses-123', visible }));
  });
}

function findByTestID(root: Instance, testID: string): Instance[] {
  return root.findAll(node => node.props.testID === testID);
}

function textContent(root: Instance): string[] {
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    )
    .filter(child => child.length > 0);
}

beforeEach(() => {
  holder.queryState = {
    data: undefined,
    isPending: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: () => Promise.resolve(),
  };
  holder.shareSuccess = null;
  holder.unshareSuccess = null;
  holder.lastShareInput = null;
});

describe('SessionShareSection state gates', () => {
  it('shows a loading row and no create action while the session row is pending', () => {
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-state-loading')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('offers the read again instead of create when the session row failed', () => {
    holder.queryState = { ...holder.queryState, isPending: false, isError: true };
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-retry')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('shows the create form only once the read reports no live link', () => {
    holder.queryState = {
      ...holder.queryState,
      data: { public_id: null },
      isPending: false,
      dataUpdatedAt: 1,
    };
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-loading')).toHaveLength(0);
  });

  it('shows the existing-link state with the controls a replacement uses', () => {
    holder.queryState = {
      ...holder.queryState,
      data: { public_id: 'share_1' },
      isPending: false,
      dataUpdatedAt: 1,
    };
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-existing')).toHaveLength(1);
    expect(textContent(renderer.root)).toContain(i18n.t('sessionShare.existingTitle'));
    // The replacement takes the person's choice, so the duration and scope
    // controls stay on screen beside the replace action.
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'SegmentedControl'
      )
    ).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-include-new')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-rotate')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-revoke')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('replaces the existing link with the chosen duration and scope', () => {
    holder.queryState = {
      ...holder.queryState,
      data: { public_id: 'share_1' },
      isPending: false,
      dataUpdatedAt: 1,
    };
    const renderer = renderSection();

    const duration = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'SegmentedControl'
    )[0];
    if (!duration) {
      throw new Error('missing duration control');
    }
    act(() => {
      (duration.props.onChange as (value: string) => void)('1d');
    });
    const include = findByTestID(renderer.root, 'session-share-include-new')[0];
    if (!include) {
      throw new Error('missing include switch');
    }
    act(() => {
      (include.props.onValueChange as (value: boolean) => void)(true);
    });
    const replace = findByTestID(renderer.root, 'session-share-rotate')[0];
    if (!replace) {
      throw new Error('missing replace action');
    }
    act(() => {
      (replace.props.onPress as () => void)();
    });

    expect(holder.lastShareInput).toEqual({
      session_id: 'ses-123',
      duration: '1d',
      include_new_messages: true,
    });
  });
});

describe('SessionShareSection created link', () => {
  async function renderCreatedLink(): Promise<Renderer> {
    holder.queryState = {
      ...holder.queryState,
      data: { public_id: 'share_1' },
      isPending: false,
      dataUpdatedAt: 1,
    };
    const renderer = renderSection();
    const onSuccess = holder.shareSuccess;
    if (onSuccess === null) {
      throw new Error('the share mutation was not registered');
    }
    await act(async () => {
      await onSuccess({ share_token: 'tok_1' });
    });
    return renderer;
  }

  it('shows the created link once the share mutation succeeds', async () => {
    const renderer = await renderCreatedLink();

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(textContent(renderer.root)).toContain('http://localhost:3000/s/tok_1');
  });

  it('drops the link when a later read reports it gone', async () => {
    const renderer = await renderCreatedLink();

    // A read that started after the create, answering that no link exists: the
    // link expired, was revoked, or was rotated out elsewhere.
    holder.queryState = {
      ...holder.queryState,
      data: { public_id: null },
      dataUpdatedAt: Date.now() + 1_000,
    };
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(1);
  });

  it('drops the link when the sheet closes', async () => {
    const renderer = await renderCreatedLink();

    rerenderSection(renderer, false);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
  });
});
