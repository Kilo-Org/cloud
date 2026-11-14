import { act, TestRenderer } from '@/test/renderer';
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { SessionShareSection } from './session-share-section';

/** What the section's fresh identity read returns when Copy or Share runs. */
type ShareRefetchResult = {
  data?: { public_id?: string | null };
  isError: boolean;
};

/** What the section's `cliSessionsV2.get` read returns; every case replaces it. */
type ShareQueryState = {
  data?: { public_id?: string | null };
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: (options?: { cancelRefetch?: boolean }) => Promise<ShareRefetchResult>;
};

type ShareHandler = (created: {
  share_token: string;
  public_id?: string | null;
}) => Promise<void> | void;

/** What the section asks the share mutation to create. */
type ShareInput = {
  session_id: string;
  duration: string;
  include_new_messages: boolean;
};

const holder = vi.hoisted(
  (): {
    queryState: ShareQueryState;
    refetchResult: ShareRefetchResult;
    refetchCalls: unknown[];
    clipboardWrites: string[];
    shares: { message: string; url: string }[];
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
      refetch: () => Promise.resolve({ isError: false }),
    },
    refetchResult: { isError: false, data: { public_id: 'share_1' } },
    refetchCalls: [],
    clipboardWrites: [],
    shares: [],
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
vi.mock('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    holder.clipboardWrites.push(text);
    await Promise.resolve();
    return true;
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Share: {
    share: async (options: { message: string; url: string }) => {
      holder.shares.push(options);
      await Promise.resolve();
      return { action: 'sharedAction' };
    },
  },
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

/**
 * Press an action and let everything it starts settle inside `act`: the fresh
 * read, the clipboard import, and the state updates their outcomes produce.
 */
async function pressAndSettle(button: Instance): Promise<void> {
  await act(async () => {
    (button.props.onPress as () => void)();
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  holder.queryState = {
    data: undefined,
    isPending: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: async (options?: { cancelRefetch?: boolean }) => {
      holder.refetchCalls.push(options);
      await Promise.resolve();
      return holder.refetchResult;
    },
  };
  holder.refetchResult = { isError: false, data: { public_id: 'share_1' } };
  holder.refetchCalls = [];
  holder.clipboardWrites = [];
  holder.shares = [];
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
  async function renderCreatedLink(
    created: { share_token: string; public_id?: string | null } = {
      share_token: 'tok_1',
      public_id: 'share_1',
    }
  ): Promise<Renderer> {
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
      await onSuccess(created);
    });
    return renderer;
  }

  it('shows the created link once the share mutation succeeds', async () => {
    const renderer = await renderCreatedLink();

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(textContent(renderer.root)).toContain('http://localhost:3000/s/tok_1');
  });

  it('keeps offering the link while a later read names the same capability', async () => {
    const renderer = await renderCreatedLink();

    // A read taken after the create that names the same capability: still live.
    holder.queryState = {
      ...holder.queryState,
      data: { public_id: 'share_1' },
      dataUpdatedAt: Date.now() + 1_000,
    };
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(0);
  });

  it('keeps the link when an older web server answers without a capability', async () => {
    /* A web server older than the create response's capability field answers
       with the token alone. There is nothing to compare, so the link must not
       look replaced once the read reports the identity the worker wrote. */
    const renderer = await renderCreatedLink({ share_token: 'tok_1' });

    holder.queryState = {
      ...holder.queryState,
      data: { public_id: 'share_1' },
      dataUpdatedAt: Date.now() + 1_000,
    };
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(0);
  });

  it('stops offering Copy for the URL this sheet made when a read names another capability', async () => {
    /* Rotating the link from another device writes a fresh capability, so the
       URL this sheet holds is revoked while it still looks live here. Comparing
       identities is what tells that from the link still being the live one. */
    const renderer = await renderCreatedLink();

    holder.queryState = {
      ...holder.queryState,
      data: { public_id: 'share_2' },
      dataUpdatedAt: Date.now() + 1_000,
    };
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-rotate')).toHaveLength(1);
    // The current link can still be ended, and its confirmation says it is the
    // current one.
    expect(findByTestID(renderer.root, 'session-share-revoke')).toHaveLength(1);
  });

  it('shows the replaced line when a later read reports no link at all', async () => {
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
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('drops the link when the sheet closes', async () => {
    const renderer = await renderCreatedLink();

    rerenderSection(renderer, false);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
  });

  it('withholds Copy when a press-time read names another capability', async () => {
    /* The sheet stays open on one device while another rotates the link. The
       cached row still names the old capability, so only a read taken at the
       press can tell that Copy would hand out a dead URL. */
    const renderer = await renderCreatedLink();
    holder.refetchResult = { isError: false, data: { public_id: 'share_2' } };

    const copy = findByTestID(renderer.root, 'session-share-copy')[0];
    if (!copy) {
      throw new Error('missing copy action');
    }
    await pressAndSettle(copy);

    expect(holder.clipboardWrites).toEqual([]);
    expect(holder.refetchCalls).toEqual([{ cancelRefetch: false }]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
  });

  it('withholds the system share sheet when a press-time read names another capability', async () => {
    const renderer = await renderCreatedLink();
    holder.refetchResult = { isError: false, data: { public_id: 'share_2' } };

    const share = findByTestID(renderer.root, 'session-share-sheet')[0];
    if (!share) {
      throw new Error('missing share action');
    }
    await pressAndSettle(share);

    expect(holder.shares).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
  });

  it('blocks distribution and offers the read again when the press-time read fails', async () => {
    const renderer = await renderCreatedLink();
    holder.refetchResult = { isError: true, data: undefined };

    const copy = findByTestID(renderer.root, 'session-share-copy')[0];
    if (!copy) {
      throw new Error('missing copy action');
    }
    await pressAndSettle(copy);

    expect(holder.clipboardWrites).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-retry')).toHaveLength(1);
  });

  it('hands the URL to Copy and Share when the press-time read names the same capability', async () => {
    const renderer = await renderCreatedLink();

    const copy = findByTestID(renderer.root, 'session-share-copy')[0];
    if (!copy) {
      throw new Error('missing copy action');
    }
    await pressAndSettle(copy);
    expect(holder.clipboardWrites).toEqual(['http://localhost:3000/s/tok_1']);
    expect(holder.refetchCalls).toEqual([{ cancelRefetch: false }]);

    const share = findByTestID(renderer.root, 'session-share-sheet')[0];
    if (!share) {
      throw new Error('missing share action');
    }
    await pressAndSettle(share);
    expect(holder.shares).toEqual([
      { message: 'http://localhost:3000/s/tok_1', url: 'http://localhost:3000/s/tok_1' },
    ]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
  });

  it('distributes a link created without an identity without comparing it', async () => {
    /* A web server older than the create response's capability field leaves
       nothing to compare, so Copy must not be blocked by a read that would
       otherwise look like a replacement. */
    const renderer = await renderCreatedLink({ share_token: 'tok_1' });
    holder.refetchResult = { isError: false, data: { public_id: 'share_2' } };

    const copy = findByTestID(renderer.root, 'session-share-copy')[0];
    if (!copy) {
      throw new Error('missing copy action');
    }
    await pressAndSettle(copy);

    expect(holder.clipboardWrites).toEqual(['http://localhost:3000/s/tok_1']);
    expect(holder.refetchCalls).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
  });
});
