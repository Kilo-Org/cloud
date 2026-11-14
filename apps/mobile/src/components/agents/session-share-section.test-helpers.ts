import { act, TestRenderer } from '@/test/renderer';
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, vi } from 'vitest';

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
export { holder };

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

export type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

export function renderSection(visible = true): Renderer {
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

export function rerenderSection(renderer: Renderer, visible = true): void {
  act(() => {
    renderer.update(createElement(SessionShareSection, { sessionId: 'ses-123', visible }));
  });
}

export function findByTestID(root: Instance, testID: string): Instance[] {
  return root.findAll(node => node.props.testID === testID);
}

export function textContent(root: Instance): string[] {
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
export async function pressAndSettle(button: Instance): Promise<void> {
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
