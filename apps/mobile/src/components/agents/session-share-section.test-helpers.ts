import type * as ReactI18next from 'react-i18next';
import { beforeEach, vi } from 'vitest';

import { i18n } from '@/i18n';

/** What the section's fresh identity read returns when Copy or Share runs. */
export type ShareRefetchResult = {
  data?: { public_id?: string | null };
  isError: boolean;
};

/** What the section's `cliSessionsV2.get` read returns; every case replaces it. */
export type ShareQueryState = {
  data?: { public_id?: string | null };
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: (options?: { cancelRefetch?: boolean }) => Promise<ShareRefetchResult>;
};

export type ShareCreated = {
  share_token: string;
  public_id?: string | null;
};

/** What the section asks the share mutation to create. */
type ShareInput = {
  session_id: string;
  duration: string;
  include_new_messages: boolean;
};

type ShareSuccess = (
  created: ShareCreated,
  input: ShareInput | null,
  context: unknown
) => Promise<void> | void;

type ShareFailure = (error: unknown, input: ShareInput | null, context: unknown) => void;

type ShareConfirmConfig = { onConfirm: () => void };

/** The handlers the section registered with each mutation. */
type MutationOptions = {
  share?: boolean;
  unshare?: boolean;
  onMutate?: () => unknown;
  onSuccess?: (result: unknown, input: unknown, context: unknown) => unknown;
  onError?: (error: unknown, input: unknown, context: unknown) => unknown;
};

const holder = vi.hoisted(
  (): {
    queryState: ShareQueryState;
    queryOptions: unknown;
    refetchResult: ShareRefetchResult;
    refetchCalls: unknown[];
    clipboardWrites: string[];
    shares: { message: string; url: string }[];
    shareSuccess: ShareSuccess | null;
    shareError: ShareFailure | null;
    shareOnMutate: (() => unknown) | null;
    shareContext: unknown;
    lastShareInput: ShareInput | null;
    lastUnshareInput: unknown;
    confirm: ShareConfirmConfig | null;
  } => ({
    queryState: {
      data: undefined,
      isPending: true,
      isError: false,
      isFetching: false,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve({ isError: false }),
    },
    queryOptions: null,
    refetchResult: { isError: false, data: { public_id: 'share_1' } },
    refetchCalls: [],
    clipboardWrites: [],
    shares: [],
    shareSuccess: null,
    shareError: null,
    shareOnMutate: null,
    shareContext: undefined,
    lastShareInput: null,
    lastUnshareInput: undefined,
    confirm: null,
  })
);
export { holder };

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => {
    holder.queryOptions = options;
    return holder.queryState;
  },
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  useMutation: (options: MutationOptions) => {
    if (options.share === true) {
      const success = options.onSuccess;
      holder.shareSuccess =
        success === undefined
          ? null
          : async (created, input, context) => {
              await success(created, input, context);
            };
      const failure = options.onError;
      holder.shareError =
        failure === undefined
          ? null
          : (error, input, context) => {
              failure(error, input, context);
            };
      holder.shareOnMutate = options.onMutate ?? null;
      return {
        mutate: (input: ShareInput) => {
          holder.lastShareInput = input;
          holder.shareContext = options.onMutate?.();
        },
        isPending: false,
      };
    }
    return {
      mutate: (input: unknown) => {
        holder.lastUnshareInput = input;
      },
      isPending: false,
    };
  },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      get: {
        queryOptions: (_input: unknown, options?: Record<string, unknown>) => ({ ...options }),
        queryKey: () => ['get'],
      },
      share: { mutationOptions: (config?: object) => ({ ...config, share: true }) },
      unshare: { mutationOptions: (config?: object) => ({ ...config, unshare: true }) },
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
  useConfirmDialog: () => ({
    confirm: (config: ShareConfirmConfig) => {
      holder.confirm = config;
    },
    dialog: null,
  }),
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
  holder.queryOptions = null;
  holder.refetchResult = { isError: false, data: { public_id: 'share_1' } };
  holder.refetchCalls = [];
  holder.clipboardWrites = [];
  holder.shares = [];
  holder.shareSuccess = null;
  holder.shareError = null;
  holder.shareOnMutate = null;
  holder.shareContext = undefined;
  holder.lastShareInput = null;
  holder.lastUnshareInput = undefined;
  holder.confirm = null;
});
