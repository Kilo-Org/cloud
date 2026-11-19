import { onlineManager } from '@tanstack/react-query';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deferred, flushQueryUpdates } from '@/lib/active-sessions-live-sync.test-helpers';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

import { SessionShareSection } from './session-share-section';

/*
 * The press-time identity read is the sheet's only proof that the URL it shows
 * is still the live one. This suite mounts the real section with a real
 * `QueryClient` and `onlineManager`, so the read's `networkMode` is whatever the
 * section asks for: on the default `'online'` a press while the device reports
 * offline pauses in `pending` and neither distributes nor reaches the failure
 * the panel can retry.
 */

type ShareRow = { public_id: string | null };

const state = vi.hoisted(() => ({
  get: vi.fn<() => Promise<ShareRow>>(),
  share: vi.fn<() => Promise<{ share_token: string; public_id?: string | null }>>(),
  unshare: vi.fn<() => Promise<{ success: boolean }>>(),
  clipboardWrites: [] as string[],
  shares: [] as { message: string; url: string }[],
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cliSessionsV2: {
      get: {
        queryKey: (input: { session_id: string }) => ['cliSessionsV2', 'get', input.session_id],
        queryOptions: (input: { session_id: string }) => ({
          queryKey: ['cliSessionsV2', 'get', input.session_id],
          queryFn: () => state.get(),
        }),
      },
      share: { mutationOptions: () => ({ mutationFn: () => state.share() }) },
      unshare: { mutationOptions: () => ({ mutationFn: () => state.unshare() }) },
    },
  }),
}));
vi.mock('@/lib/haptics', () => ({ notificationHaptic: () => undefined }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'http://localhost:3000' }));
vi.mock('expo-haptics', () => ({ NotificationFeedbackType: { Success: 'success' } }));
vi.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => {
    state.clipboardWrites.push(text);
    return Promise.resolve(true);
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Share: {
    share: (options: { message: string; url: string }) => {
      state.shares.push(options);
      return Promise.resolve({ action: 'sharedAction' });
    },
  },
  useColorScheme: () => 'light',
  View: 'View',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: () => undefined, dialog: null }),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The shared `cn` helper reaches `@/i18n`, which installs this plugin.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

type Renderer = ReactTestRenderer;
type Node = ReactTestInstance;

function nodes(renderer: Renderer, testID: string): Node[] {
  return renderer.root.findAll(node => node.props.testID === testID);
}

function only(renderer: Renderer, testID: string): Node {
  const [node] = nodes(renderer, testID);
  if (!node) {
    throw new Error(`missing ${testID}`);
  }
  return node;
}

function pressHandler(node: Node): () => void {
  const handler: () => void = node.props.onPress;
  return handler;
}

function press(renderer: Renderer, testID: string): void {
  const run = pressHandler(only(renderer, testID));
  act(() => {
    run();
  });
}

/** The query notifications a press schedules land in a timer, so flush inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await flushQueryUpdates();
  });
}

async function pressAndSettle(renderer: Renderer, testID: string): Promise<void> {
  const run = pressHandler(only(renderer, testID));
  await act(async () => {
    run();
    await flushQueryUpdates();
  });
}

let tree: RenderWithProvidersResult | undefined = undefined;

async function mount(): Promise<Renderer> {
  tree = await renderWithProviders(
    createElement(SessionShareSection, { sessionId: 'ses-123', visible: true })
  );
  return tree.renderer;
}

/** Create the link the sheet offers Copy and Share for. */
async function createLink(renderer: Renderer): Promise<void> {
  await waitFor(() => nodes(renderer, 'session-share-create').length === 1);
  press(renderer, 'session-share-create');
  await waitFor(() => nodes(renderer, 'session-share-url').length === 1);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onlineManager.setOnline(true);
  state.get.mockReset();
  state.get.mockResolvedValue({ public_id: null });
  state.share.mockReset();
  state.share.mockImplementation(() => {
    state.get.mockResolvedValue({ public_id: 'share_1' });
    return Promise.resolve({ share_token: 'tok_1', public_id: 'share_1' });
  });
  state.unshare.mockReset();
  state.unshare.mockResolvedValue({ success: true });
  state.clipboardWrites.length = 0;
  state.shares.length = 0;
});

afterEach(() => {
  tree?.unmount();
  tree = undefined;
  onlineManager.setOnline(true);
});

describe('SessionShareSection offline distribution', () => {
  it('attempts the fresh read while offline for Copy and settles into Retry without copying', async () => {
    const renderer = await mount();
    await createLink(renderer);

    act(() => {
      onlineManager.setOnline(false);
    });
    const attemptsBefore = state.get.mock.calls.length;
    state.get.mockImplementation(() => Promise.reject(new Error('Network request failed')));
    const copy = pressHandler(only(renderer, 'session-share-copy'));

    act(() => {
      copy();
      copy();
    });
    await settle();
    await settle();

    // The attempt, not a paused read: `SETTLE_WHILE_OFFLINE` sends it and the
    // failure settles it. One guarded press, so the duplicate started nothing.
    expect(state.get.mock.calls.length - attemptsBefore).toBe(1);
    expect(state.clipboardWrites).toEqual([]);
    expect(state.shares).toEqual([]);

    await waitFor(() => nodes(renderer, 'session-share-state-error').length === 1);
    expect(nodes(renderer, 'session-share-state-retry')).toHaveLength(1);
    expect(nodes(renderer, 'session-share-url')).toHaveLength(0);

    // The read again recovers the live link instead of leaving the sheet stuck.
    state.get.mockResolvedValue({ public_id: 'share_1' });
    await pressAndSettle(renderer, 'session-share-state-retry');
    await waitFor(() => nodes(renderer, 'session-share-url').length === 1);
    expect(state.clipboardWrites).toEqual([]);
  });

  it('attempts the fresh read while offline for Share and never opens the system sheet', async () => {
    const renderer = await mount();
    await createLink(renderer);

    act(() => {
      onlineManager.setOnline(false);
    });
    const attemptsBefore = state.get.mock.calls.length;
    state.get.mockImplementation(() => Promise.reject(new Error('Network request failed')));
    await pressAndSettle(renderer, 'session-share-sheet');
    await settle();

    expect(state.get.mock.calls.length - attemptsBefore).toBe(1);
    expect(state.shares).toEqual([]);
    expect(state.clipboardWrites).toEqual([]);

    await waitFor(() => nodes(renderer, 'session-share-state-error').length === 1);
    expect(nodes(renderer, 'session-share-state-retry')).toHaveLength(1);
    expect(nodes(renderer, 'session-share-url')).toHaveLength(0);
    expect(state.shares).toEqual([]);
  });

  it('runs one distribution for same-tick presses and disables every entry point while it runs', async () => {
    const renderer = await mount();
    await createLink(renderer);
    // Let the create's invalidation read finish before swapping the read's
    // implementation: only the presses below may start a read.
    await settle();

    const read = deferred<ShareRow>();
    state.get.mockReset();
    state.get.mockImplementation(() => read.promise);
    const copy = pressHandler(only(renderer, 'session-share-copy'));
    const share = pressHandler(only(renderer, 'session-share-sheet'));
    const url = pressHandler(only(renderer, 'session-share-url'));

    act(() => {
      copy();
      share();
      url();
      copy();
    });
    await settle();

    expect(state.get).toHaveBeenCalledTimes(1);
    expect(only(renderer, 'session-share-copy').props.disabled).toBe(true);
    expect(only(renderer, 'session-share-copy').props.loading).toBe(true);
    expect(only(renderer, 'session-share-sheet').props.disabled).toBe(true);
    expect(only(renderer, 'session-share-url').props.disabled).toBe(true);
    expect(only(renderer, 'session-share-revoke').props.disabled).toBe(true);

    read.resolve({ public_id: 'share_1' });
    await waitFor(() => state.clipboardWrites.length === 1);

    // The presses that arrived while the read was in flight never earned a
    // native effect: the one they raced copied the URL.
    expect(state.clipboardWrites).toEqual(['http://localhost:3000/s/tok_1']);
    expect(state.shares).toEqual([]);
    expect(state.get).toHaveBeenCalledTimes(1);
  });
});
