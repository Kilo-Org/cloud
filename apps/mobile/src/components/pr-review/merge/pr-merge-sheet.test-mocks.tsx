import { createElement, useState } from 'react';
import { vi } from 'vitest';
import {
  type EnableAutoMergeVars,
  type MergeVars,
} from '@/lib/pr-review/merge/use-pr-merge-mutations';

type MergeResult = {
  merged: boolean;
  sha: string;
  branchDeleted: boolean;
  branchDeleteError?: string;
};
type AutoMergeResult = { enabled?: boolean };

type Confirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

const state = vi.hoisted(() => ({
  identity: { userId: 'u1' as string | undefined, isLoading: false },
  merge: {
    mutateAsync: vi.fn<(input: MergeVars) => Promise<MergeResult>>(),
    isPending: false,
    error: null as Error | null,
  },
  autoMerge: {
    mutateAsync: vi.fn<(input: EnableAutoMergeVars) => Promise<AutoMergeResult>>(),
    isPending: false,
    error: null as Error | null,
  },
  rows: new Map<string, string>(),
  backgroundListeners: new Set<(next: string) => void>(),
  getItem: vi.fn<(scope: string, key: string) => Promise<string | null>>(),
}));

export { state };

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
  Switch: 'Switch',
  Pressable: 'Pressable',
  Platform: { OS: 'ios' },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.backgroundListeners.add(listener);
      return { remove: () => state.backgroundListeners.delete(listener) };
    },
  },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'Success' },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-operation' }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: () => state.identity }));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: state.getItem,
  setItem: (scope: string, key: string, value: string) => {
    state.rows.set(`${scope}\u0000${key}`, value);
    return Promise.resolve();
  },
  removeItem: (scope: string, key: string) => {
    state.rows.delete(`${scope}\u0000${key}`);
    return Promise.resolve();
  },
  listEntries: () => Promise.resolve([]),
}));
vi.mock('@/lib/pr-review/merge/use-pr-merge-mutations', () => ({
  useMergePullRequestMutation: () => state.merge,
  useEnableAutoMergeMutation: () => state.autoMerge,
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => {
    const [request, setRequest] = useState<Confirmation | null>(null);
    return {
      confirm: setRequest,
      dialog: request
        ? createElement(
            'ConfirmDialog',
            { title: request.title, message: request.message },
            createElement('Button', {
              // eslint-disable-next-line no-literal-copy/no-literal-copy -- test-only label distinguishes the confirmation from the sheet CTA
              accessibilityLabel: `Confirm ${request.confirmLabel}`,
              onPress: () => {
                setRequest(null);
                request.onConfirm();
              },
            })
          )
        : null,
    };
  },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: ({
    label,
    checked,
    disabled,
  }: {
    label: string;
    checked: boolean;
    disabled: boolean;
  }) => ({
    accessibilityLabel: label,
    accessibilityState: { checked, disabled },
  }),
}));
vi.mock('@/components/ui/icons', () => ({
  AlertTriangle: 'AlertTriangle',
  GitBranch: 'GitBranch',
  GitPullRequest: 'GitPullRequest',
  ShieldAlert: 'ShieldAlert',
  XCircle: 'XCircle',
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
