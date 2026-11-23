/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatRow } from '@/components/chat/chat-row';
import { i18n } from '@/i18n';
import type { ChatSummary } from '@/lib/chat/store';
import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * A synced row: the origin badge names where the session started, a runner
 * elsewhere lights the row, and deleting it says it deletes on every device.
 */

const h = vi.hoisted(() => ({
  confirmRequest: {
    value: null as null | { title: string; message: string; onConfirm: () => void },
  },
  actionSheet: vi.fn(),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1, width: 400, height: 800 }),
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: h.actionSheet }),
}));
vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Warning: 'warning' },
}));
vi.mock('@/lib/haptics', () => ({ notificationHaptic: vi.fn(), selectionHaptic: vi.fn() }));
vi.mock('@/components/rename-modal', () => ({ RenameModal: 'RenameModal' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    dialog: null,
    confirm: (request: { title: string; message: string; onConfirm: () => void }) => {
      h.confirmRequest.value = request;
    },
  }),
}));
vi.mock('@/components/ui/session-row', () => ({ SessionRow: 'SessionRow' }));
vi.mock('@/components/ui/icons', () => ({
  Cloud: 'Cloud',
  Smartphone: 'Smartphone',
  Terminal: 'Terminal',
}));
vi.mock('@/lib/hooks/use-themed-action-sheet', () => ({
  useThemedActionSheetOptions: () => ({}),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888', foreground: '#111' }),
}));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useRelativeTimeNow: () => 1000 }));
vi.mock('@/lib/chat/use-chat', () => ({ useChatStatus: () => 'idle' }));

const chat: ChatSummary = {
  sessionId: 'ses_local',
  model: 'kilo/test',
  title: 'Deploy notes',
  preview: 'the newest words',
  updatedAt: 100,
};

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
beforeEach(() => {
  h.confirmRequest.value = null;
  h.actionSheet.mockReset();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

type RowProps = {
  origin?: 'mobile' | 'cli' | 'cloud-agent' | null;
  liveRemote?: boolean;
  deleteEverywhere?: boolean;
};

async function mount(over: RowProps, onDelete = vi.fn()) {
  view = await renderWithProviders(
    createElement(ChatRow, {
      chat,
      modelName: 'Kilo',
      last: true,
      onPress: () => undefined,
      onDelete,
      onRename: async () => undefined,
      ...over,
    })
  );
  return { tree: view.renderer, onDelete };
}

/** Opens the long-press menu and picks Delete, which asks the confirm first. */
async function deleteThroughMenu(tree: TestRenderer.ReactTestRenderer): Promise<void> {
  const pressable = tree.root
    .findAll(node => node.props.onLongPress !== undefined)
    .at(0) as unknown as { props: { onLongPress: () => void } };
  h.actionSheet.mockImplementation((_options: unknown, answer: (index: number) => void) => {
    answer(1);
  });
  await act(async () => {
    pressable.props.onLongPress();
    await Promise.resolve();
  });
}

describe('ChatRow under sync', () => {
  it('shows the origin badge and a live mark from another device', async () => {
    const { tree } = await mount({ origin: 'cli', liveRemote: true });
    const row = tree.root.findAllByProps({ agentLabel: 'Kilo' }).at(0);
    expect(row?.props.live).toBe(true);
    const icon = tree.root.findAll(node => node.props.accessibilityLabel !== undefined).at(-1);
    expect(JSON.stringify(icon?.props.accessibilityLabel)).toContain(
      i18n.t('agentChat.sessionFilter.platformCli')
    );
  });

  it('keeps a local-only chat out of the badge state', async () => {
    const { tree } = await mount({});
    const row = tree.root.findAllByProps({ agentLabel: 'Kilo' }).at(0);
    expect(row?.props.platformIcon).toBeUndefined();
    expect(row?.props.live).toBe(false);
  });

  it('says a synced chat deletes on every device', async () => {
    const { tree } = await mount({ deleteEverywhere: true });
    await deleteThroughMenu(tree);
    const request = h.confirmRequest.value;
    expect(request?.title).toBe(i18n.t('modelChat.sync.deleteEverywhereTitle'));
    expect(request?.message).toContain(i18n.t('modelChat.sync.deleteEverywhereBody'));
  });

  it('keeps the local-only wording when sync is off', async () => {
    const { tree } = await mount({});
    await deleteThroughMenu(tree);
    expect(h.confirmRequest.value?.title).toBe(i18n.t('modelChat.list.deleteTitle'));
  });
});
